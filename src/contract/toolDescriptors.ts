import type {
  MemoryExecutableToolName,
  MemoryKernel,
  MemoryModelToolName,
  MemoryToolCall,
  MemoryToolCallEnvelope,
  MemoryToolDescriptor,
  MemoryToolExecutionContext,
  MemoryToolResult
} from "./types.js";

const defaultScopeAliases: MemoryToolCallEnvelope["allowed_scope_aliases"] = [
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
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

export const memoryToolSpecs: MemoryToolSpec[] = [
  {
    name: "memory.search",
    modelName: "memory_search",
    label: "Memory Search",
    description: "Search scoped long-term memory through the policy boundary.",
    promptSnippet: "Search scoped memory for relevant prior events.",
    promptGuidelines: [
      "Use memory_search before answering when prior room, pair, team, or global context may matter.",
      "Treat redacted or private results as boundaries; do not infer hidden content."
    ]
  },
  {
    name: "memory.locate",
    modelName: "memory_locate",
    label: "Memory Locate",
    description: "Locate which scoped memories may contain an answer without exposing private content.",
    promptSnippet: "Locate memory candidates without necessarily exposing their content.",
    promptGuidelines: [
      "Use memory_locate when you suspect another scope has relevant history but need to respect privacy."
    ]
  },
  {
    name: "memory.register",
    modelName: "memory_register",
    label: "Memory Register",
    description: "Register a durable memory with explicit evidence and visibility.",
    promptSnippet: "Register durable memories with evidence and an explicit visibility.",
    promptGuidelines: [
      "Use memory_register for stable facts, decisions, relationships, or artifacts that should survive future turns.",
      "Choose the narrowest visibility that fits the memory."
    ]
  },
  {
    name: "memory.summarize",
    modelName: "memory_summarize",
    label: "Memory Summarize",
    description: "Summarize recent memory in a scope and store the summary as memory.",
    promptSnippet: "Summarize a memory scope when history is too verbose.",
    promptGuidelines: [
      "Use memory_summarize to compact a scope before a long-running task or after a meaningful exchange."
    ]
  },
  {
    name: "memory.forget",
    modelName: "memory_forget",
    label: "Memory Forget",
    description: "Write tombstones for memories that should no longer be recalled.",
    promptSnippet: "Forget memories by writing tombstones instead of mutating history.",
    promptGuidelines: [
      "Use memory_forget only for explicitly obsolete, wrong, or policy-unsafe memories."
    ]
  }
];

export const createMemoryToolEnvelope = (
  context: MemoryToolExecutionContext
): MemoryToolCallEnvelope => ({
  version: "mneme.memory.tool.v1",
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

export const createMemoryToolDescriptors = (
  kernel: MemoryKernel
): MemoryToolDescriptor[] =>
  memoryToolSpecs.map((spec) => ({
    ...spec,
    invoke: (argumentsValue, context) =>
      executeMemoryTool(kernel, spec.name, createMemoryToolCall(spec.name, argumentsValue, context))
  }));

