import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { createMemoryToolDescriptors } from "../contract/toolDescriptors.js";
import type { MemoryToolResult } from "../contract/types.js";
import {
  createMcpToolContext,
  resolveMnemeMcpConfig,
  type MnemeMcpServerConfig
} from "./config.js";
import { schemaForModelToolName } from "./schemas.js";

const annotationsFor = (name: string): ToolAnnotations => {
  if (name === "memory_search" || name === "memory_locate") {
    return { readOnlyHint: true, openWorldHint: false };
  }
  if (name === "memory_forget") {
    return { destructiveHint: true, openWorldHint: false };
  }
  if (name === "memory_promote") {
    return { destructiveHint: false, openWorldHint: false };
  }
  return { openWorldHint: false };
};

const toolResult = (result: MemoryToolResult): CallToolResult => ({
  content: [{
    type: "text",
    text: JSON.stringify(result, null, 2)
  }],
  structuredContent: result as unknown as Record<string, unknown>
});

export const createMnemeMcpServer = (config: MnemeMcpServerConfig): McpServer => {
  const resolved = resolveMnemeMcpConfig(config);
  const server = new McpServer({
    name: "mneme",
    version: "0.1.1"
  });

  for (const descriptor of createMemoryToolDescriptors(resolved.runtime.kernel, { mode: resolved.mode })) {
    server.registerTool(
      descriptor.modelName,
      {
        title: descriptor.label,
        description: descriptor.description,
        inputSchema: schemaForModelToolName(descriptor.modelName),
        annotations: annotationsFor(descriptor.modelName)
      },
      async (args: Record<string, unknown>) => {
        const result = await descriptor.invoke(
          args as Record<string, unknown>,
          createMcpToolContext(resolved, descriptor.modelName)
        );
        return toolResult(result);
      }
    );
  }

  return server;
};

export const connectMnemeMcpStdio = async (config: MnemeMcpServerConfig): Promise<McpServer> => {
  const server = createMnemeMcpServer(config);
  await server.connect(new StdioServerTransport());
  return server;
};
