import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  canonicalScopeKey,
  makeChecksum,
  makeEventId
} from "../identity/ids.js";
import type {
  MemoryEvent,
  MemoryEventInput
} from "../contract/types.js";

export interface MemoryStoreQuery {
  scope?: string;
  principalAgentId?: string;
  principalScope?: string;
  principalQualifier?: string;
  types?: string[];
  tags?: string[];
  search?: string;
}

export interface MemoryStore {
  append(event: MemoryEventInput): Promise<MemoryEvent>;
  appendBatch(events: MemoryEventInput[]): Promise<MemoryEvent[]>;
  read(query?: MemoryStoreQuery): Promise<MemoryEvent[]>;
  clear(): Promise<void>;
}

export class JsonlMemoryStore implements MemoryStore {
  private readonly eventsPath: string;
  private readonly dirPath: string;

  constructor(runtimeHomePath: string) {
    this.dirPath = path.join(runtimeHomePath, "memory");
    this.eventsPath = path.join(this.dirPath, "events.jsonl");
  }

  private async appendOne(input: MemoryEventInput): Promise<MemoryEvent> {
    const createdAt = new Date().toISOString();
    const event: MemoryEvent = {
      id: makeEventId(),
      type: input.type,
      createdAt,
      principal: input.principal,
      scope: canonicalScopeKey(input.scope),
      visibility: input.visibility,
      source: input.source,
      content: input.content,
      tags: (input.tags ?? []).map((tag) => tag.toLowerCase()),
      entities: (input.entities ?? []).map((entity) => entity.toLowerCase()),
      sensitivity: input.sensitivity ?? "normal",
      ttl: input.ttl,
      parentEventIds: input.parentEventIds ?? [],
      checksum: makeChecksum({
        ...input,
        id: "__temporary__",
        createdAt,
        checksum: ""
      })
    };

    await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
    return event;
  }

  async append(input: MemoryEventInput): Promise<MemoryEvent> {
    return this.appendBatch([input]).then((events) => events[0]);
  }

  async appendBatch(inputs: MemoryEventInput[]): Promise<MemoryEvent[]> {
    await mkdir(this.dirPath, { recursive: true });
    if (inputs.length === 0) {
      return [];
    }

    const events: MemoryEvent[] = [];
    for (const input of inputs) {
      events.push(await this.appendOne(input));
    }
    return events;
  }

  async clear(): Promise<void> {
    await appendFile(this.eventsPath, "", { encoding: "utf8", flag: "w" }).catch(() => Promise.resolve());
  }

  async read(query: MemoryStoreQuery = {}): Promise<MemoryEvent[]> {
    let payload = "";
    try {
      payload = await readFile(this.eventsPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const queryText = (query.search ?? "").toLowerCase();
    const searchTokens = queryText
      .split(/\W+/u)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    const result: MemoryEvent[] = [];
    const wantedTags = (query.tags ?? []).map((tag) => tag.toLowerCase());
    const wantedTypes = query.types;

    for (const line of payload.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let event: MemoryEvent;
      try {
        event = JSON.parse(trimmed) as MemoryEvent;
      } catch {
        continue;
      }

      if (query.scope && event.scope !== canonicalScopeKey(query.scope)) {
        continue;
      }

      if (query.principalAgentId && event.principal.agentId !== query.principalAgentId) {
        continue;
      }

      if (query.principalScope && event.principal.scope !== query.principalScope) {
        continue;
      }

      if (query.principalQualifier && event.principal.qualifier !== query.principalQualifier) {
        continue;
      }

      if (wantedTypes && wantedTypes.length > 0 && !wantedTypes.includes(event.type)) {
        continue;
      }

      if (wantedTags.length > 0 && !wantedTags.some((tag) => event.tags.includes(tag))) {
        continue;
      }

      if (searchTokens.length > 0) {
        const eventText = JSON.stringify(event.content).toLowerCase();
        const matched = searchTokens.every((token) => eventText.includes(token));
        if (!matched) {
          continue;
        }
      }

      result.push(event);
    }

    return result.sort((left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
  }
}
