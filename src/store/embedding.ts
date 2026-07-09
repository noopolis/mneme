export interface MemoryEmbeddingProvider {
  embed(text: string): Promise<number[]>;
  dimensions?: number;
}

export interface OllamaEmbeddingProviderConfig {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  dimensions?: number;
}

interface OllamaEmbeddingResponse {
  embedding?: unknown;
}

const clearableAbort = (milliseconds: number): AbortController => {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, milliseconds);

  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
  }, { once: true });

  return controller;
};

const isFiniteNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));

export const validateEmbeddingVector = (
  value: unknown,
  expectedDimensions?: number,
  label?: string
): number[] => {
  const context = label ?? "embedding";
  if (!isFiniteNumberArray(value)) {
    throw new Error(`${context} must be an array of finite numbers`);
  }

  if (expectedDimensions !== undefined && value.length !== expectedDimensions) {
    throw new Error(`${context} dimension mismatch; expected ${expectedDimensions}, got ${value.length}`);
  }

  return value;
};

const normalizeBaseUrl = (value: string): URL => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("baseUrl is required");
  }
  return new URL(value);
};

export const createOllamaEmbeddingProvider = (input: OllamaEmbeddingProviderConfig): MemoryEmbeddingProvider => {
  const base = normalizeBaseUrl(input.baseUrl);
  const model = input.model.trim();
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? Math.floor(input.timeoutMs)
    : 10_000;

  if (model.length === 0) {
    throw new Error("model is required");
  }

  const dimensions = input.dimensions;
  if (dimensions !== undefined && (!Number.isFinite(dimensions) || dimensions <= 0)) {
    throw new Error("dimensions must be a positive number");
  }

  const endpoint = new URL("/api/embeddings", base);

  return {
    dimensions,
    embed: async (text: string): Promise<number[]> => {
      const controller = clearableAbort(timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            prompt: text
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
        }

        const payload = await response.json() as OllamaEmbeddingResponse;
        return validateEmbeddingVector(payload.embedding, dimensions, "Ollama response embedding");
      } finally {
        controller.abort();
      }
    }
  };
};
