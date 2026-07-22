import { createHash } from "node:crypto";

import type { MemoryToolName, MemoryToolResult } from "../contract/types.js";

export const UNTRUSTED_ARGUMENT_SHA256 = createHash("sha256")
  .update("mneme.untrusted-tool-call.argument.v1\0")
  .digest("hex");
export const UNTRUSTED_REQUEST_SHA256 = createHash("sha256")
  .update("mneme.untrusted-tool-call.request.v1\0")
  .digest("hex");

const UNTRUSTED_REQUEST_ID = "mneme:uncorrelated-invalid-request";
const UNTRUSTED_PRINCIPAL = Object.freeze({ agentId: "mneme-system", scope: "global" as const });

const result = (
  tool: MemoryToolName,
  decision: "malformed_request" | "unavailable",
  startAt: number
): MemoryToolResult => ({
  request_id: UNTRUSTED_REQUEST_ID,
  tool,
  decision,
  content: [],
  audit: {
    request_id: UNTRUSTED_REQUEST_ID,
    requester: UNTRUSTED_PRINCIPAL,
    sources: [],
    transport: "in_process",
    latency_ms: Date.now() - startAt,
    argument_hash: UNTRUSTED_ARGUMENT_SHA256
  },
  error: decision === "malformed_request" ? "invalid authority" : "memory service unavailable"
});

export const malformedUntrustedToolCall = (tool: MemoryToolName, startAt: number): MemoryToolResult =>
  result(tool, "malformed_request", startAt);

export const unavailableUntrustedToolCall = (tool: MemoryToolName, startAt: number): MemoryToolResult =>
  result(tool, "unavailable", startAt);
