import * as z from "zod/v4";

export const searchInputSchema = {
  scope: z.string().describe("Scope alias or canonical scope id. Use current, global, or all when appropriate."),
  query: z.string().describe("Search query."),
  limit: z.number().optional().describe("Maximum result count.")
};

export const locateInputSchema = {
  query: z.string().describe("What to locate in memory."),
  limit: z.number().optional().describe("Maximum candidate count."),
  active_scope: z.string().optional().describe("Optional active scope hint.")
};

const memoryContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("claim"), subject: z.string(), predicate: z.string(), object: z.string() }),
  z.object({ kind: z.literal("decision"), decision: z.string(), rationale: z.string().optional() }),
  z.object({ kind: z.literal("artifact"), path: z.string().optional(), uri: z.string().optional(), description: z.string() }),
  z.object({ kind: z.literal("relationship"), from: z.string(), relation: z.string(), to: z.string() })
]);

const principalSchema = z.object({
  agentId: z.string(),
  scope: z.enum(["global", "team", "room", "pair", "task", "role", "artifact"]),
  qualifier: z.string().optional()
});

export const registerInputSchema = {
  scope: z.string().describe("Scope alias or canonical scope id where the memory belongs."),
  kind: z.string().describe("Memory content kind."),
  content: memoryContentSchema.describe("Structured memory content."),
  visibility: z.enum(["private", "pair", "team", "room", "global", "public", "sealed"]),
  sensitivity: z.enum(["normal", "sensitive", "secret"]),
  evidence_event_ids: z.array(z.string()).min(1).describe("Event ids that justify the memory."),
  source_type: z.string().describe("Source label for the registered memory."),
  confidence: z.number().optional().describe("Confidence from 0 to 1."),
  principal: principalSchema.optional().describe("Optional principal override for the stored memory.")
};

export const summarizeInputSchema = {
  scope: z.string().describe("Scope alias or canonical scope id to summarize."),
  horizon: z.number().optional().describe("Approximate number of recent memories to include.")
};

export const forgetInputSchema = {
  scope: z.string().describe("Scope alias or canonical scope id for the tombstone."),
  event_ids: z.array(z.string()).min(1).describe("Memory event ids to tombstone."),
  reason: z.string().optional().describe("Why these memories should be forgotten.")
};

export const schemaForModelToolName = (name: string) => {
  if (name === "memory_search") return searchInputSchema;
  if (name === "memory_locate") return locateInputSchema;
  if (name === "memory_register") return registerInputSchema;
  if (name === "memory_summarize") return summarizeInputSchema;
  return forgetInputSchema;
};
