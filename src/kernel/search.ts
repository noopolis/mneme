import { memoryPolicy } from "../policy/policy.js";
import { runRecall } from "../recall/recall.js";
import type { MemoryDecision, MemoryEvent, MemoryPrincipalRef } from "../contract/types.js";
import type { MemoryEmbeddingProvider } from "../store/embedding.js";
import { collectTombstones, isRecallableMemoryEvent, matchesQuery } from "./support.js";

interface SearchInput {
  scope: string;
  queryText: string;
  limit: number;
  allEvents: MemoryEvent[];
  requester: MemoryPrincipalRef;
  allowedScopes: string[];
  embeddingProvider?: MemoryEmbeddingProvider;
  index: {
    query: (input: {
      allowedScopes?: string[];
      query?: string;
      limit?: number;
    }) => Promise<{ event: MemoryEvent; score: number }[]>;
    queryByEmbedding: (input: {
      allowedScopes?: string[];
      queryVector: number[];
      embeddingProvider: MemoryEmbeddingProvider;
      limit: number;
    }) => Promise<{ event: MemoryEvent; score: number }[]>;
  };
}

export interface SearchResult {
  candidates: Array<{ event: MemoryEvent; decision: MemoryDecision }>;
  embeddingScores?: Map<string, number>;
  queryEvents: Array<{ event: MemoryEvent; score: number }>;
}

const maybeQueryByEmbedding = async (
  input: SearchInput,
  resolvedScope: string,
  queryLimit: number,
  queryText: string,
  queryVector: number[]
): Promise<{ events: Array<{ event: MemoryEvent; score: number }>; scores: Map<string, number> | undefined }> => {
  try {
    const semantic = await input.index.queryByEmbedding({
      allowedScopes: resolvedScope === "all" ? input.allowedScopes : [resolvedScope],
      queryVector,
      embeddingProvider: input.embeddingProvider!,
      limit: queryLimit
    });

    if (semantic.length > 0) {
      return {
        events: semantic,
        scores: new Map(semantic.map((entry) => [entry.event.id, entry.score]))
      };
    }
  } catch (_error) {
    // Semantic retrieval failures fall back to lexical flow.
  }

  return { events: await input.index.query({
    allowedScopes: resolvedScope === "all" ? input.allowedScopes : [resolvedScope],
    query: queryText,
    limit: queryLimit
  }), scores: undefined };
};

export const prepareSearchCandidates = async (input: SearchInput): Promise<SearchResult> => {
  const limit = asNumberOrDefault(input.limit, 20);
  const resolvedScope = input.scope;
  const queryLimit = Math.max(limit * 4, 40);
  const queryText = input.queryText;

  let queryEvents = await input.index.query({
    allowedScopes: resolvedScope === "all" ? input.allowedScopes : [resolvedScope],
    query: queryText,
    limit: queryLimit
  });
  let embeddingScores: Map<string, number> | undefined;

  if (input.embeddingProvider && queryText.trim().length > 0) {
    try {
      const queryVector = await input.embeddingProvider.embed(queryText);
      ({ events: queryEvents, scores: embeddingScores } = await maybeQueryByEmbedding(
        input,
        resolvedScope,
        queryLimit,
        queryText,
        queryVector
      ));
    } catch (_error) {
      // Keep lexical retrieval when embedding vectorization fails.
    }
  }

  const eventRows = queryEvents.map((entry) => entry.event);
  const tombstones = collectTombstones(input.allEvents);
  const events = eventRows
    .filter((event) => isRecallableMemoryEvent(event) && !tombstones.has(event.id))
    .filter((event) => embeddingScores ? true : matchesQuery(event, queryText));

  const candidates = resolvedScope === "all"
    ? events
      .map((event) => ({
        event,
        decision: memoryPolicy({
          request: input.requester,
          candidate: event,
          activeScope: input.requester
        }).decision
      }))
      .filter((entry) => entry.decision !== "deny")
      .sort((left, right) => {
        if (embeddingScores) {
          const leftScore = embeddingScores.get(left.event.id) ?? 0;
          const rightScore = embeddingScores.get(right.event.id) ?? 0;
          const scoreDelta = rightScore - leftScore;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
        }

        return Date.parse(right.event.createdAt) - Date.parse(left.event.createdAt);
      })
    : runRecall({
      actor: input.requester,
      scopeIds: [resolvedScope],
      events,
      query: queryText,
      maxTokens: limit * 80,
      embeddingScores
    }).selected.map((entry) => ({
      event: entry.event,
      decision: entry.decision
    }));

  return {
    candidates,
    embeddingScores,
    queryEvents
  };
};

const asNumberOrDefault = (value: number, fallback: number): number => {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};
