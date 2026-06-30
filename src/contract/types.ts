export interface MemoryPrincipalRef {
  agentId: string;
  scope: "global" | "team" | "room" | "pair" | "task" | "role" | "artifact";
  qualifier?: string;
}

export type MemoryWakeKind = "manual" | "message" | "schedule";

export interface MemoryToolCallEnvelope {
  version: "mneme.memory.tool.v1";
  wake_id: string;
  thread_id: string;
  principal: MemoryPrincipalRef;
  conversation_scope: string;
  audience_key: string;
  policy_version: string;
  allowed_scope_aliases: ReadonlyArray<
    "current" | "global" | "public_profile" | "public_facts" |
    "current_room" | "current_pair" | "current_task"
  >;
  transport: "in_process" | "mcp" | "protocol" | "text_loop";
  nonce: string;
  expires_at: string;
  capability: string;
}

export type MemoryToolName =
  | "memory.search"
  | "memory.locate"
  | "memory.register"
  | "memory.write"
  | "memory.summarize"
  | "memory.forget";

export type MemoryExecutableToolName = Exclude<MemoryToolName, "memory.write">;

export type MemoryModelToolName =
  | "memory_search"
  | "memory_locate"
  | "memory_register"
  | "memory_summarize"
  | "memory_forget";

export interface MemoryToolExecutionContext {
  wakeId: string;
  threadId: string;
  principal: MemoryPrincipalRef;
  conversationScope: string;
  audienceKey?: string;
  policyVersion?: string;
  allowedScopeAliases?: MemoryToolCallEnvelope["allowed_scope_aliases"];
  transport?: MemoryToolCallEnvelope["transport"];
  expiresAt?: string;
  nonce?: string;
  capability?: string;
}

export interface MemoryToolCall {
  request_id: string;
  tool: MemoryToolName;
  arguments: Record<string, unknown>;
  envelope: MemoryToolCallEnvelope;
}

export type MemoryToolDecision =
  | "allow_raw"
  | "allow_summary"
  | "allow_redacted_summary"
  | "known_but_private"
  | "locate_only"
  | "deny"
  | "unavailable"
  | "malformed_request";

export interface MemoryContext {
  networkId?: string;
  roomId?: string;
  teamId?: string;
  taskId?: string;
  roleId?: string;
  pairPeers?: string[];
  artifactPaths?: string[];
  from?: string;
}

export interface WakeMemoryContext extends MemoryContext {
  participants?: string[];
}

export interface MemoryToolResultContent {
  kind: "memory" | "claim" | "narrative" | "relationship" | "artifact" | "locate";
  text?: string;
  event_ids: string[];
  scope?: string;
  principal?: MemoryPrincipalRef;
  confidence?: number;
  redactions: string[];
}

export interface MemoryToolAudit {
  request_id: string;
  requester: MemoryPrincipalRef;
  sources: MemoryPrincipalRef[];
  transport: "in_process" | "mcp" | "protocol" | "text_loop";
  latency_ms: number;
  argument_hash?: string;
}

export interface MemoryToolResult {
  request_id: string;
  tool: MemoryToolName;
  decision: MemoryToolDecision;
  content: MemoryToolResultContent[];
  audit: MemoryToolAudit;
  error?: string;
}

export interface MemorySearchArguments {
  scope: string;
  query: string;
  limit?: number;
}

export interface MemoryLocateArguments {
  query: string;
  limit?: number;
  active_scope?: string;
}

export type MemoryRegisterKind = MemoryContent["kind"] | "text";

export interface MemoryRegisterArguments {
  scope: string;
  kind: MemoryRegisterKind;
  content: MemoryContent;
  visibility: MemoryVisibility;
  sensitivity: MemorySensitivity;
  evidence_event_ids: string[];
  source_type: string;
  confidence?: number;
  principal?: MemoryPrincipalRef;
}

export interface MemorySummarizeArguments {
  scope: string;
  horizon?: number;
}

export interface MemoryForgetArguments {
  scope: string;
  event_ids: string[];
  reason?: string;
}

export interface MemoryKernel {
  search(call: MemoryToolCall): Promise<MemoryToolResult>;
  locate(call: MemoryToolCall): Promise<MemoryToolResult>;
  register(call: MemoryToolCall): Promise<MemoryToolResult>;
  summarize(call: MemoryToolCall): Promise<MemoryToolResult>;
  forget(call: MemoryToolCall): Promise<MemoryToolResult>;
}

export interface MemoryToolDescriptor {
  name: MemoryExecutableToolName;
  modelName: MemoryModelToolName;
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  invoke(
    argumentsValue: Record<string, unknown>,
    context: MemoryToolExecutionContext
  ): Promise<MemoryToolResult>;
}

export type MemoryVisibility = "private" | "pair" | "team" | "room" | "global" | "public" | "sealed";

export type MemorySensitivity = "normal" | "sensitive" | "secret";

export type MemoryEventType =
  | "memory.observed"
  | "memory.claimed"
  | "memory.registered"
  | "memory.summarized"
  | "memory.recalled"
  | "memory.located"
  | "memory.denied"
  | "memory.forgotten";

export type MemoryContent =
  | { kind: "text"; text: string }
  | { kind: "claim"; subject: string; predicate: string; object: string }
  | { kind: "decision"; decision: string; rationale?: string }
  | { kind: "artifact"; path?: string; uri?: string; description: string }
  | { kind: "relationship"; from: string; relation: string; to: string };

export interface MemoryEvent {
  id: string;
  type: MemoryEventType;
  createdAt: string;
  principal: MemoryPrincipalRef;
  scope: string;
  visibility: MemoryVisibility;
  source: string;
  content: MemoryContent;
  tags: string[];
  entities: string[];
  sensitivity: MemorySensitivity;
  confidence?: number;
  ttl?: string;
  parentEventIds: string[];
  checksum: string;
}

export interface MemoryEventInput {
  type: MemoryEventType;
  principal: MemoryPrincipalRef;
  scope: string;
  visibility: MemoryVisibility;
  source: string;
  content: MemoryContent;
  tags?: string[];
  entities?: string[];
  sensitivity?: MemorySensitivity;
  confidence?: number;
  ttl?: string;
  parentEventIds?: string[];
}

export type MemoryDecision =
  | "allow_raw"
  | "allow_summary"
  | "allow_redacted_summary"
  | "known_but_private"
  | "locate_only"
  | "deny"
  | "unavailable"
  | "malformed_request";

export interface MemoryPolicyInput {
  request: MemoryPrincipalRef;
  activeScope?: MemoryPrincipalRef;
  candidate: MemoryEvent;
}

export interface MemoryRecallAudit {
  totalCandidates: number;
  selectedEventIds: string[];
  selected?: Array<{
    eventId: string;
    decision: MemoryDecision;
    scope: string;
    representation: string;
  }>;
  decisions: Array<{
    eventId: string;
    decision: MemoryDecision;
    reason: string;
  }>;
  tokenBudgetUsed: number;
  redactionCount: number;
}

export interface MemoryPacket {
  principal: MemoryPrincipalRef;
  sections: Array<{
    heading: string;
    text: string;
  }>;
  rawHint?: string;
}

export interface MemoryPacketInput {
  activePrincipal: MemoryPrincipalRef;
  event: {
    id: string;
    kind: string;
    text: string;
    from?: string;
  };
  context: WakeMemoryContext;
  recalls: Array<{
    event: MemoryEvent;
    decision: MemoryDecision;
    representation: string;
    scope: string;
  }>;
}

export interface MemoryRecallRequest {
  eventId: string;
  kind: MemoryWakeKind;
  text: string;
  from?: string;
  context: WakeMemoryContext;
  tokenBudget?: number;
}

export interface MemoryPrepareTurnResult {
  principal: MemoryPrincipalRef;
  packet: MemoryPacket;
  promptText: string;
  recall: MemoryRecallAudit;
}

export interface MemoryTurnRecord {
  principal: MemoryPrincipalRef;
  prompt: MemoryPacket;
  request: MemoryRecallRequest;
  recall?: MemoryRecallAudit;
  result: "completed" | "failed";
  outputText: string;
  toolEvents?: unknown[];
  error?: string;
}

export interface MemoryRuntime {
  prepareTurn(request: MemoryRecallRequest): Promise<MemoryPrepareTurnResult>;
  recordTurn(input: MemoryTurnRecord): Promise<void>;
  kernel: MemoryKernel;
}
