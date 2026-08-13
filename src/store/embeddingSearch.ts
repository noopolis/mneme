import type { MemoryEmbeddingProvider } from "./embedding.js";
import { validateEmbeddingVector } from "./embedding.js";
import type {
  MemoryEvent,
  MemoryEventType,
  MemoryPrincipalRef
} from "../contract/types.js";

export interface MemoryIndexEmbeddingQuery {
  allowedScopes?: string[];
  tags?: string[];
  entities?: string[];
  types?: MemoryEventType[];
  principalAgentId?: string;
  principalScope?: MemoryPrincipalRef["scope"];
  principalQualifier?: string;
  queryVector: number[];
  embeddingProvider: MemoryEmbeddingProvider;
  limit?: number;
  offset?: number;
}

export interface MemoryEmbeddingMatch {
  event: MemoryEvent;
  score: number;
}

type ContentForEmbedding = MemoryEvent["content"];

const eventTextForEmbedding = (event: MemoryEvent): string => {
  const content = event.content;
  if (content.kind === "text") {
    return content.text;
  }
  if (content.kind === "decision") {
    return `${content.decision}${content.rationale ? ` ${content.rationale}` : ""}`;
  }
  if (content.kind === "artifact") {
    return content.description;
  }
  if (content.kind === "relationship") {
    return `${content.from} ${content.relation} ${content.to}`;
  }
  if (content.kind === "claim") {
    return `${content.subject} ${content.predicate} ${content.object}`;
  }

  return JSON.stringify(content as unknown as ContentForEmbedding);
};

const cosineSimilarity = (left: number[], right: number[]): number => {
  let dotProduct = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    dotProduct += left[i] * right[i];
    leftNorm += left[i] ** 2;
    rightNorm += right[i] ** 2;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
};

export const rankEventsByEmbedding = async (
  events: ReadonlyArray<MemoryEvent>,
  queryVector: number[],
  embeddingProvider: MemoryEmbeddingProvider
): Promise<MemoryEmbeddingMatch[]> => {
  return Promise.all(events.map(async (event) => {
    const vector = validateEmbeddingVector(
      await embeddingProvider.embed(eventTextForEmbedding(event)),
      queryVector.length,
      `embedding provider result for ${event.id}`
    );
    return {
      event,
      score: cosineSimilarity(queryVector, vector)
    };
  }));
};
