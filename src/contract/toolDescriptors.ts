import type {
  MemoryExecutableToolName,
  MemoryKernel,
  MemoryModelToolName,
  MemoryToolCall,
  MemoryToolCallEnvelope,
  MemoryToolDescriptor,
  MemoryToolExecutionContext,
  MemoryToolResult,
  MemoryWakeMode
} from "./types.js";

const defaultScopeAliases: MemoryToolCallEnvelope["allowed_scope_aliases"] = [
  "all",
  "current",
  "global",
  "public_profile",
  "public_facts",
  "current_room",
  "current_pair",
  "current_task"
];

interface MemoryToolSpec {
  name: MemoryExecutableToolName;
  modelName: MemoryModelToolName;
  label: string;
}

export interface MemoryModeAwareInstructions {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

export const MEMORY_TOOLS_AWAKE = [
  "memory.search",
  "memory.locate",
  "memory.register",
  "memory.summarize",
  "memory.forget"
] as const satisfies ReadonlyArray<MemoryExecutableToolName>;

export const MEMORY_TOOLS_DREAM_SAFE = [
  "memory.search",
  "memory.locate",
  "memory.register",
  "memory.summarize",
  "memory.forget"
] as const satisfies ReadonlyArray<MemoryExecutableToolName>;

export const AWAKE_MEMORY_SKILL_TEXT = [
  "# Mneme Memory",
  "",
  "You are awake and may use Mneme when durable context matters.",
  "Search before answering when prior room, pair, team, task, or global memory may change the answer.",
  "Register only stable facts, decisions, relationships, artifacts, or summaries that should survive future turns.",
  "Choose the narrowest visibility that fits the memory and respect redacted or private results as hard boundaries."
].join("\n");

export const DREAM_MEMORY_SKILL_TEXT = [
  "# Mneme Dream",
  "",
  "You are in dream mode for memory maintenance, not normal conversation.",
  "Audit, consolidate, summarize, retire, and improve durable memory quality with evidence-backed tool calls.",
  "Do not treat the dream prompt as a user-facing request and do not produce a normal chat reply unless the harness explicitly asks for a report.",
  "Prefer conservative confidence, narrow visibility, explicit provenance, and tombstones over destructive edits."
].join("\n");

export const AWAKE_MEMORY_TOOL_INSTRUCTIONS: Record<
  MemoryExecutableToolName,
  MemoryModeAwareInstructions
> = {
  "memory.search": {
    description: "Search scoped long-term memory through the policy boundary.",
    promptSnippet: "Search scoped memory for relevant prior events.",
    promptGuidelines: [
      "Use memory_search before answering when prior room, pair, team, or global context may matter.",
      "Treat redacted or private results as boundaries; do not infer hidden content."
    ]
  },
  "memory.locate": {
    description: "Locate which scoped memories may contain an answer without exposing private content.",
    promptSnippet: "Locate memory candidates without necessarily exposing their content.",
    promptGuidelines: [
      "Use memory_locate when you suspect another scope has relevant history but need to respect privacy."
    ]
  },
  "memory.register": {
    description: "Register a durable memory with explicit evidence and visibility.",
    promptSnippet: "Register durable memories with evidence and an explicit visibility.",
    promptGuidelines: [
      "Use memory_register for stable facts, decisions, relationships, or artifacts that should survive future turns.",
      "Choose the narrowest visibility that fits the memory."
    ]
  },
  "memory.summarize": {
    description: "Summarize recent memory in a scope and store the summary as memory.",
    promptSnippet: "Summarize a memory scope when history is too verbose.",
    promptGuidelines: [
      "Use memory_summarize to compact a scope before a long-running task or after a meaningful exchange."
    ]
  },
  "memory.forget": {
    description: "Write tombstones for memories that should no longer be recalled.",
    promptSnippet: "Forget memories by writing tombstones instead of mutating history.",
    promptGuidelines: [
      "Use memory_forget only for explicitly obsolete, wrong, or policy-unsafe memories."
    ]
  }
};

export const DREAM_MEMORY_TOOL_INSTRUCTIONS: Record<
  MemoryExecutableToolName,
  MemoryModeAwareInstructions
> = {
  "memory.search": {
    description: "Audit scoped memory for maintenance signals before consolidation work.",
    promptSnippet: "Search scoped memory for audit context during consolidation turns.",
    promptGuidelines: [
      "Use memory_search in dream mode only to inspect what durable knowledge already exists.",
      "Treat the result as maintenance context and avoid proposing user-facing narrative changes."
    ]
  },
  "memory.locate": {
    description: "Locate scoped memory candidates for audit and consolidation review.",
    promptSnippet: "Locate memory candidates for validation and housekeeping.",
    promptGuidelines: [
      "Use memory_locate to identify candidates for consolidation, deduplication, or retirement.",
      "Do not expose private details in consolidation-facing outputs."
    ]
  },
  "memory.register": {
    description: "Register durable consolidated memories with explicit evidence and conservative visibility.",
    promptSnippet: "Register durable entries only after evidence-backed review in maintenance mode.",
    promptGuidelines: [
      "Use memory_register for consolidation outputs with clear provenance.",
      "Prefer conservative confidence and narrow visibility by default."
    ]
  },
  "memory.summarize": {
    description: "Create and persist maintenance summaries for noisy scopes.",
    promptSnippet: "Summarize and compact scope history for future recall quality.",
    promptGuidelines: [
      "Use memory_summarize for consolidation and audit hygiene.",
      "Keep summaries focused, evidence-aware, and minimally verbose."
    ]
  },
  "memory.forget": {
    description: "Retire stale, duplicate, or unsafe memories with explicit tombstones.",
    promptSnippet: "Forget memories only as a maintenance action with explicit rationale.",
    promptGuidelines: [
      "Use memory_forget for controlled housekeeping and policy-driven cleanup.",
      "Provide explicit event ids and a clear reason."
    ]
  }
};

const MEMORY_TOOL_MODELS: Record<MemoryExecutableToolName, MemoryModelToolName> = {
  "memory.search": "memory_search",
  "memory.locate": "memory_locate",
  "memory.register": "memory_register",
  "memory.summarize": "memory_summarize",
  "memory.forget": "memory_forget"
};

const MEMORY_TOOL_LABELS: Record<MemoryExecutableToolName, string> = {
  "memory.search": "Memory Search",
  "memory.locate": "Memory Locate",
  "memory.register": "Memory Register",
  "memory.summarize": "Memory Summarize",
  "memory.forget": "Memory Forget"
};

const getInstructionTextForMode = (mode: MemoryWakeMode): Record<
  MemoryExecutableToolName,
  MemoryModeAwareInstructions
> => (mode === "dream" ? DREAM_MEMORY_TOOL_INSTRUCTIONS : AWAKE_MEMORY_TOOL_INSTRUCTIONS);

export const getAwakeMemoryToolInstructions = (): Record<
  MemoryExecutableToolName,
  MemoryModeAwareInstructions
> => AWAKE_MEMORY_TOOL_INSTRUCTIONS;

export const getDreamMemoryToolInstructions = (): Record<
  MemoryExecutableToolName,
  MemoryModeAwareInstructions
> => DREAM_MEMORY_TOOL_INSTRUCTIONS;

export const getAwakeMemorySkillText = (): string => AWAKE_MEMORY_SKILL_TEXT;

export const getDreamMemorySkillText = (): string => DREAM_MEMORY_SKILL_TEXT;

export const getMemorySkillTextForMode = (mode: MemoryWakeMode): string =>
  mode === "dream" ? DREAM_MEMORY_SKILL_TEXT : AWAKE_MEMORY_SKILL_TEXT;

export interface MemoryToolDescriptorsOptions {
  mode?: MemoryWakeMode;
  toolNames?: ReadonlyArray<MemoryExecutableToolName>;
}

const toolModeDefaultNames = (mode: MemoryWakeMode): ReadonlyArray<MemoryExecutableToolName> =>
  mode === "dream" ? MEMORY_TOOLS_DREAM_SAFE : MEMORY_TOOLS_AWAKE;

const toOrderedToolSpecs = (mode: MemoryWakeMode, toolNames?: ReadonlyArray<MemoryExecutableToolName>): MemoryToolSpec[] => {
  const requested = toolNames && toolNames.length > 0
    ? new Set(toolNames)
    : new Set(toolModeDefaultNames(mode));
  const ordered = toolModeDefaultNames(mode);
  return ordered.filter((tool) => requested.has(tool)).map((tool) => ({
    name: tool,
    modelName: MEMORY_TOOL_MODELS[tool],
    label: MEMORY_TOOL_LABELS[tool]
  }));
};

export const createMemoryToolDescriptors = (
  kernel: MemoryKernel,
  options: MemoryToolDescriptorsOptions = {}
): MemoryToolDescriptor[] => {
  const mode = options.mode ?? "awake";
  const instructions = getInstructionTextForMode(mode);

  return toOrderedToolSpecs(mode, options.toolNames).map((spec) => ({
    ...spec,
    ...instructions[spec.name],
    invoke: (argumentsValue, context) =>
      executeMemoryTool(
        kernel,
        spec.name,
        createMemoryToolCall(spec.name, argumentsValue, context)
      )
  }));
};

export const createMemoryToolEnvelope = (
  context: MemoryToolExecutionContext
): MemoryToolCallEnvelope => ({
  version: "mneme.memory.tool.v1",
  mode: context.mode ?? "awake",
  wake_id: context.wakeId,
  thread_id: context.threadId,
  principal: context.principal,
  conversation_scope: context.conversationScope,
  audience_key: context.audienceKey ?? context.principal.agentId,
  policy_version: context.policyVersion ?? "memory-policy.v1",
  allowed_scope_aliases: context.allowedScopeAliases ?? defaultScopeAliases,
  transport: context.transport ?? "in_process",
  nonce: context.nonce ?? `${context.wakeId}:${Date.now()}`,
  expires_at: context.expiresAt ?? new Date(Date.now() + 5 * 60_000).toISOString(),
  capability: context.capability ?? "memory"
});

const createMemoryToolCall = (
  tool: MemoryExecutableToolName,
  argumentsValue: Record<string, unknown>,
  context: MemoryToolExecutionContext
): MemoryToolCall => ({
  request_id: `${context.wakeId}:${tool}:${Date.now()}`,
  tool,
  arguments: argumentsValue,
  envelope: createMemoryToolEnvelope(context)
});

const executeMemoryTool = (
  kernel: MemoryKernel,
  tool: MemoryExecutableToolName,
  call: MemoryToolCall
): Promise<MemoryToolResult> => {
  if (tool === "memory.search") return kernel.search(call);
  if (tool === "memory.locate") return kernel.locate(call);
  if (tool === "memory.register") return kernel.register(call);
  if (tool === "memory.summarize") return kernel.summarize(call);
  return kernel.forget(call);
};
