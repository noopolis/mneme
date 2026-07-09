import { memoryScopeId } from "../identity/ids.js";
import type {
  MemoryPrincipalRef,
  MemoryRuntime,
  MemoryToolExecutionContext,
  MemoryWakeMode
} from "../contract/types.js";
import { createMemoryRuntime } from "../runtime/runtime.js";
import { createOllamaEmbeddingProvider, type MemoryEmbeddingProvider } from "../store/embedding.js";

export interface MnemeMcpEmbeddingConfig {
  baseUrl?: string;
  dimensions?: number;
  model: string;
  provider: "ollama";
  timeoutMs?: number;
}

export interface MnemeMcpServerConfig {
  runtimeHomePath: string;
  agentId: string;
  mode?: MemoryWakeMode;
  agentScope?: MemoryPrincipalRef["scope"];
  agentQualifier?: string;
  conversationScope?: string;
  audienceKey?: string;
  policyVersion?: string;
  source?: string;
  tokenBudget?: number;
  embedding?: MnemeMcpEmbeddingConfig;
  runtime?: MemoryRuntime;
}

export interface ResolvedMnemeMcpConfig extends Required<
  Pick<MnemeMcpServerConfig, "runtimeHomePath" | "agentId" | "conversationScope" | "audienceKey" | "policyVersion" | "mode">
> {
  principal: MemoryPrincipalRef;
  source?: string;
  tokenBudget?: number;
  runtime: MemoryRuntime;
  mode: MemoryWakeMode;
}

const createEmbeddingProvider = (
  embedding?: MnemeMcpEmbeddingConfig
): MemoryEmbeddingProvider | undefined => {
  if (!embedding) {
    return undefined;
  }

  if (embedding.provider !== "ollama") {
    throw new Error(`Unsupported Mneme MCP embedding provider: ${embedding.provider}`);
  }

  return createOllamaEmbeddingProvider({
    baseUrl: embedding.baseUrl ?? process.env.MNEME_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    dimensions: embedding.dimensions,
    model: embedding.model,
    timeoutMs: embedding.timeoutMs
  });
};

export const resolveMnemeMcpConfig = (config: MnemeMcpServerConfig): ResolvedMnemeMcpConfig => {
  const principal: MemoryPrincipalRef = {
    agentId: config.agentId,
    scope: config.agentScope ?? "global",
    qualifier: config.agentQualifier
  };

  return {
    runtimeHomePath: config.runtimeHomePath,
    agentId: config.agentId,
    mode: config.mode ?? "awake",
    principal,
    conversationScope: config.conversationScope ?? memoryScopeId(principal),
    audienceKey: config.audienceKey ?? config.agentId,
    policyVersion: config.policyVersion ?? "memory-policy.v1",
    source: config.source,
    tokenBudget: config.tokenBudget,
    runtime: config.runtime ?? createMemoryRuntime({
      agentId: config.agentId,
      embeddingProvider: createEmbeddingProvider(config.embedding),
      runtimeHomePath: config.runtimeHomePath,
      source: config.source,
      tokenBudget: config.tokenBudget
    })
  };
};

export const createMcpToolContext = (
  config: ResolvedMnemeMcpConfig,
  toolName: string
): MemoryToolExecutionContext => {
  const now = Date.now();
  return {
    mode: config.mode,
    wakeId: `mcp-${now}`,
    threadId: `mcp:${config.audienceKey}`,
    principal: config.principal,
    conversationScope: config.conversationScope,
    audienceKey: config.audienceKey,
    policyVersion: config.policyVersion,
    transport: "mcp",
    nonce: `mcp:${toolName}:${now}`
  };
};

export const parseMnemeMcpArgs = (
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): MnemeMcpServerConfig => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith("--")) {
      continue;
    }
    const key = current.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      values.set(key, "true");
      continue;
    }
    values.set(key, next);
    index += 1;
  }

  const runtimeHomePath = values.get("runtime-home") ?? env.MNEME_RUNTIME_HOME;
  const agentId = values.get("agent-id") ?? env.MNEME_AGENT_ID;
  if (!runtimeHomePath) {
    throw new Error("mneme mcp requires --runtime-home or MNEME_RUNTIME_HOME");
  }
  if (!agentId) {
    throw new Error("mneme mcp requires --agent-id or MNEME_AGENT_ID");
  }

  const tokenBudgetText = values.get("token-budget") ?? env.MNEME_TOKEN_BUDGET;
  const tokenBudget = tokenBudgetText ? Number.parseInt(tokenBudgetText, 10) : undefined;
  const modeValue = values.get("mode") ?? env.MNEME_MODE ?? "awake";
  if (modeValue !== "awake" && modeValue !== "dream") {
    throw new Error(`mneme mcp mode must be "awake" or "dream": ${modeValue}`);
  }
  const embeddingModel = values.get("embedding-model") ?? env.MNEME_EMBEDDING_MODEL;
  const embeddingDimensionsText = values.get("embedding-dimensions") ?? env.MNEME_EMBEDDING_DIMENSIONS;
  const embeddingTimeoutText = values.get("embedding-timeout-ms") ?? env.MNEME_EMBEDDING_TIMEOUT_MS;
  const embeddingDimensions = embeddingDimensionsText ? Number.parseInt(embeddingDimensionsText, 10) : undefined;
  const embeddingTimeoutMs = embeddingTimeoutText ? Number.parseInt(embeddingTimeoutText, 10) : undefined;

  return {
    runtimeHomePath,
    agentId,
    mode: modeValue,
    agentScope: (values.get("agent-scope") ?? env.MNEME_AGENT_SCOPE) as MemoryPrincipalRef["scope"] | undefined,
    agentQualifier: values.get("agent-qualifier") ?? env.MNEME_AGENT_QUALIFIER,
    conversationScope: values.get("conversation-scope") ?? env.MNEME_CONVERSATION_SCOPE,
    audienceKey: values.get("audience-key") ?? env.MNEME_AUDIENCE_KEY,
    policyVersion: values.get("policy-version") ?? env.MNEME_POLICY_VERSION,
    source: values.get("source") ?? env.MNEME_SOURCE,
    tokenBudget: Number.isFinite(tokenBudget) ? tokenBudget : undefined,
    ...(embeddingModel
      ? {
          embedding: {
            baseUrl: values.get("embedding-base-url") ?? env.MNEME_EMBEDDING_BASE_URL,
            dimensions: Number.isFinite(embeddingDimensions) ? embeddingDimensions : undefined,
            model: embeddingModel,
            provider: (values.get("embedding-provider") ?? env.MNEME_EMBEDDING_PROVIDER ?? "ollama") as "ollama",
            timeoutMs: Number.isFinite(embeddingTimeoutMs) ? embeddingTimeoutMs : undefined
          }
        }
      : {})
  };
};
