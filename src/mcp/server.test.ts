import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { memoryScopeId } from "../identity/ids.js";
import { JsonlMemoryStore } from "../store/store.js";
import { createMnemeMcpServer } from "./server.js";

const tempRoots: string[] = [];

const firstTextContent = (result: unknown): string => {
  assert.ok(result && typeof result === "object" && "content" in result);
  const content = (result as { content: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, "text");
  const text = first.text;
  if (typeof text !== "string") {
    throw new Error("expected first MCP content item to be text");
  }
  return text;
};

const tempDir = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mneme-mcp-"));
  tempRoots.push(directory);
  return directory;
};

test.afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("MCP server lists and calls Mneme memory tools through the protocol", async () => {
  const root = await tempDir();
  const principal = { agentId: "luna", scope: "room" as const, qualifier: "noopolis:agora" };
  await new JsonlMemoryStore(root).append({
    type: "memory.observed",
    principal,
    scope: memoryScopeId(principal),
    visibility: "room",
    source: "mcp-test",
    content: { kind: "text", text: "MCP_MARKER survives the Mneme protocol boundary." },
    tags: ["mcp"],
    entities: ["mcp"],
    sensitivity: "normal",
    parentEventIds: []
  });

  const server = createMnemeMcpServer({
    runtimeHomePath: root,
    agentId: "luna",
    agentScope: "room",
    agentQualifier: "noopolis:agora"
  });
  const client = new Client({ name: "mneme-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "memory_forget",
      "memory_locate",
      "memory_register",
      "memory_search",
      "memory_summarize"
    ]);

    const result = await client.callTool({
      name: "memory_search",
      arguments: { scope: "current", query: "MCP_MARKER", limit: 5 }
    });
    const parsed = JSON.parse(firstTextContent(result));
    assert.equal(parsed.tool, "memory.search");
    assert.equal(parsed.audit.transport, "mcp");
    assert.ok(JSON.stringify(parsed.content).includes("MCP_MARKER"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP register tool writes memories that search can read", async () => {
  const root = await tempDir();
  const server = createMnemeMcpServer({
    runtimeHomePath: root,
    agentId: "keeper"
  });
  const client = new Client({ name: "mneme-register-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const registered = await client.callTool({
      name: "memory_register",
      arguments: {
        scope: "current",
        kind: "text",
        content: { kind: "text", text: "REGISTERED_BY_MCP belongs to keeper." },
        visibility: "private",
        sensitivity: "normal",
        evidence_event_ids: ["evt_external"],
        source_type: "mcp-test",
        confidence: 0.9
      }
    });
    const parsedRegister = JSON.parse(firstTextContent(registered));
    assert.equal(parsedRegister.decision, "allow_raw");

    const result = await client.callTool({
      name: "memory_search",
      arguments: { scope: "current", query: "REGISTERED_BY_MCP", limit: 5 }
    });
    const parsedSearch = JSON.parse(firstTextContent(result));
    assert.ok(JSON.stringify(parsedSearch.content).includes("REGISTERED_BY_MCP"));
  } finally {
    await client.close();
    await server.close();
  }
});
