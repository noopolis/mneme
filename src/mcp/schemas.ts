import * as z from "zod/v4";

export const searchInputSchema = z.object({
  scope: z.string().describe("Scope alias or canonical scope id. Use current, global, or all when appropriate."),
  query: z.string().describe("Search query."),
  limit: z.number().optional().describe("Maximum result count.")
}).strict();

export const locateInputSchema = z.object({
  query: z.string().describe("What to locate in memory."),
  limit: z.number().optional().describe("Maximum candidate count."),
  active_scope: z.string().optional().describe("Optional active scope hint.")
}).strict();

const memoryContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("claim"), subject: z.string(), predicate: z.string(), object: z.string() }),
  z.object({ kind: z.literal("decision"), decision: z.string(), rationale: z.string().optional() }),
  z.object({ kind: z.literal("artifact"), path: z.string().optional(), uri: z.string().optional(), description: z.string() }),
  z.object({ kind: z.literal("relationship"), from: z.string(), relation: z.string(), to: z.string() })
]);

export const registerInputSchema = z.object({
  scope: z.string().describe("Scope alias or canonical scope id where the memory belongs."),
  kind: z.string().describe("Memory content kind."),
  content: memoryContentSchema.describe("Structured memory content."),
  visibility: z.enum(["private", "pair", "team", "room", "global", "public", "sealed"]),
  sensitivity: z.enum(["normal", "sensitive", "secret"]),
  source_type: z.string().describe("Source label for the registered memory."),
  confidence: z.number().optional().describe("Confidence from 0 to 1."),
  memory_id: z.string().optional().describe("When set, register this as a new revision of an existing memory chain.")
}).strict().describe("Provenance is bound automatically to the authenticated current invocation.");

export const summarizeInputSchema = z.object({
  scope: z.string().describe("Scope alias or canonical scope id to summarize."),
  horizon: z.number().optional().describe("Approximate number of recent memories to include.")
}).strict();

export const forgetInputSchema = z.object({
  scope: z.string().describe("Scope alias or canonical scope id for the tombstone."),
  event_ids: z.array(z.string()).min(1).max(256).describe("Memory event ids to tombstone."),
  reason: z.string().optional().describe("Why these memories should be forgotten.")
}).strict();

export const promoteInputSchema = z.object({
  scope: z.string().describe("Scope alias or canonical scope id the memory belongs to."),
  memory_id: z.string().describe("The stable memory_id (root event id) of the chain to promote."),
  reason: z.string().optional().describe("Why this memory is being promoted.")
}).strict();

export const schemaForModelToolName = (name: string) => {
  if (name === "memory_search") return searchInputSchema;
  if (name === "memory_locate") return locateInputSchema;
  if (name === "memory_register") return registerInputSchema;
  if (name === "memory_summarize") return summarizeInputSchema;
  if (name === "memory_promote") return promoteInputSchema;
  return forgetInputSchema;
};
