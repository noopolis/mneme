import { mkdir, open, readFile } from "node:fs/promises";
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

const LEDGER_ERROR = "Invalid Mneme memory ledger";
const EVENT_TYPES = new Set([
  "memory.observed", "memory.claimed", "memory.registered", "memory.summarized",
  "memory.recalled", "memory.located", "memory.denied", "memory.forgotten",
  "memory.promoted", "memory.consolidated"
]);
const PRINCIPAL_SCOPES = new Set(["global", "team", "room", "pair", "task", "role", "artifact"]);
const VISIBILITIES = new Set(["private", "pair", "team", "room", "global", "public", "sealed"]);
const SENSITIVITIES = new Set(["normal", "sensitive", "secret"]);
const ORIGINS = new Set(["awake", "dream", "system"]);
const ledgerTails = new Map<string, Promise<void>>();

const failLedger = (): never => {
  throw new Error(LEDGER_ERROR);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const nonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const optionalString = (record: Record<string, unknown>, key: string): boolean =>
  record[key] === undefined || typeof record[key] === "string";
const exactKeys = (
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(record, key))
    && Object.keys(record).every((key) => allowed.has(key));
};

const validPrincipal = (value: unknown): boolean => {
  if (!isRecord(value) || !exactKeys(value, ["agentId", "scope"], ["qualifier"])
    || !nonEmptyString(value.agentId) || !PRINCIPAL_SCOPES.has(String(value.scope))) {
    return false;
  }
  return optionalString(value, "qualifier");
};

const validContent = (value: unknown): boolean => {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return false;
  }
  switch (value.kind) {
    case "text":
      return exactKeys(value, ["kind", "text"]) && typeof value.text === "string";
    case "claim":
      return exactKeys(value, ["kind", "subject", "predicate", "object"])
        && typeof value.subject === "string" && typeof value.predicate === "string"
        && typeof value.object === "string";
    case "decision":
      return exactKeys(value, ["kind", "decision"], ["rationale"])
        && typeof value.decision === "string" && optionalString(value, "rationale");
    case "artifact":
      return exactKeys(value, ["kind", "description"], ["path", "uri"])
        && typeof value.description === "string" && optionalString(value, "path")
        && optionalString(value, "uri");
    case "relationship":
      return exactKeys(value, ["kind", "from", "relation", "to"])
        && typeof value.from === "string" && typeof value.relation === "string"
        && typeof value.to === "string";
    default:
      return false;
  }
};

const validEventRecord = (value: unknown): boolean => {
  if (!isRecord(value) || !exactKeys(value, [
    "id", "type", "createdAt", "principal", "scope", "visibility", "source",
    "content", "tags", "entities", "sensitivity", "parentEventIds", "checksum"
  ], ["confidence", "ttl", "seq", "memoryId", "origin", "highWaterSeq"])
    || !nonEmptyString(value.id) || !EVENT_TYPES.has(String(value.type))
    || !nonEmptyString(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))
    || !validPrincipal(value.principal) || typeof value.scope !== "string"
    || !VISIBILITIES.has(String(value.visibility)) || typeof value.source !== "string"
    || !validContent(value.content) || !stringArray(value.tags) || !stringArray(value.entities)
    || !SENSITIVITIES.has(String(value.sensitivity)) || !stringArray(value.parentEventIds)
    || !nonEmptyString(value.checksum)) {
    return false;
  }
  if (value.confidence !== undefined && (typeof value.confidence !== "number" || !Number.isFinite(value.confidence))) {
    return false;
  }
  if (!optionalString(value, "ttl") || !optionalString(value, "memoryId")
    || value.origin !== undefined && !ORIGINS.has(String(value.origin))) {
    return false;
  }
  return value.highWaterSeq === undefined
    || Number.isSafeInteger(value.highWaterSeq) && Number(value.highWaterSeq) >= 0;
};

const skipWhitespace = (source: string, start: number): number => {
  let index = start;
  while (index < source.length && /[\t\r ]/u.test(source[index])) {
    index += 1;
  }
  return index;
};

const stringEnd = (source: string, start: number): number => {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
    } else if (source[index] === "\"") {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return failLedger();
};

const duplicateFreeValueEnd = (source: string, start: number): number => {
  let index = skipWhitespace(source, start);
  if (source[index] === "\"") {
    return stringEnd(source, index);
  }
  if (source[index] === "{") {
    const keys = new Set<string>();
    index = skipWhitespace(source, index + 1);
    if (source[index] === "}") return index + 1;
    while (index < source.length) {
      if (source[index] !== "\"") return failLedger();
      const end = stringEnd(source, index);
      const key = JSON.parse(source.slice(index, end)) as string;
      if (keys.has(key)) return failLedger();
      keys.add(key);
      index = skipWhitespace(source, end);
      if (source[index] !== ":") return failLedger();
      index = skipWhitespace(source, duplicateFreeValueEnd(source, index + 1));
      if (source[index] === "}") return index + 1;
      if (source[index] !== ",") return failLedger();
      index = skipWhitespace(source, index + 1);
    }
    return failLedger();
  }
  if (source[index] === "[") {
    index = skipWhitespace(source, index + 1);
    if (source[index] === "]") return index + 1;
    while (index < source.length) {
      index = skipWhitespace(source, duplicateFreeValueEnd(source, index));
      if (source[index] === "]") return index + 1;
      if (source[index] !== ",") return failLedger();
      index = skipWhitespace(source, index + 1);
    }
    return failLedger();
  }
  while (index < source.length && !/[\t\r ,}\]]/u.test(source[index])) index += 1;
  return index;
};

const parseRecord = (line: string): unknown => {
  const end = duplicateFreeValueEnd(line, 0);
  if (skipWhitespace(line, end) !== line.length) failLedger();
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return failLedger();
  }
};

/**
 * Compatibility is intentionally narrow: legacy records are otherwise-valid
 * MemoryEvents with no own `seq` property, and may appear only as one prefix.
 * Their sequence is their 1-based record position. Every following native
 * record must carry that exact next positive safe integer. Every record must
 * have its JSONL line terminator; missing final LF and blank lines are invalid.
 */
const parseLedger = (payload: string): MemoryEvent[] => {
  if (payload === "") {
    return [];
  }
  if (!payload.endsWith("\n")) {
    failLedger();
  }
  const withoutTerminalNewline = payload.slice(0, -1);
  const lines = withoutTerminalNewline.split("\n");
  const events: MemoryEvent[] = [];
  let sawNative = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line || line.trim() === "") {
      failLedger();
    }
    const raw = parseRecord(line);
    if (!validEventRecord(raw)) {
      failLedger();
    }
    const record = raw as Record<string, unknown> & Omit<MemoryEvent, "seq">;
    const expectedSeq = index + 1;
    if (Object.hasOwn(record, "seq")) {
      if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq !== expectedSeq) {
        failLedger();
      }
      sawNative = true;
      events.push({ ...record, seq: record.seq } as MemoryEvent);
      continue;
    }
    if (sawNative) {
      failLedger();
    }
    events.push({ ...record, seq: expectedSeq } as MemoryEvent);
  }
  return events;
};

const readLedger = async (eventsPath: string): Promise<MemoryEvent[]> => {
  try {
    return parseLedger(await readFile(eventsPath, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
};

const serializeLedger = <T>(eventsPath: string, operation: () => Promise<T>): Promise<T> => {
  const previous = ledgerTails.get(eventsPath) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(() => undefined, () => undefined);
  ledgerTails.set(eventsPath, tail);
  return result.finally(() => {
    if (ledgerTails.get(eventsPath) === tail) {
      ledgerTails.delete(eventsPath);
    }
  });
};

const writeDurably = async (eventsPath: string, payload: string, flag: "a" | "w"): Promise<void> => {
  const handle = await open(eventsPath, flag);
  try {
    await handle.writeFile(payload, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export class JsonlMemoryStore implements MemoryStore {
  private readonly eventsPath: string;
  private readonly dirPath: string;

  constructor(runtimeHomePath: string) {
    this.dirPath = path.resolve(runtimeHomePath, "memory");
    this.eventsPath = path.join(this.dirPath, "events.jsonl");
  }

  private createEvent(input: MemoryEventInput, seq: number): MemoryEvent {
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
      seq,
      memoryId: input.memoryId,
      origin: input.origin,
      highWaterSeq: input.highWaterSeq,
      checksum: makeChecksum({
        ...input,
        id: "__temporary__",
        createdAt,
        checksum: ""
      })
    };

    return event;
  }

  async append(input: MemoryEventInput): Promise<MemoryEvent> {
    return this.appendBatch([input]).then((events) => events[0]);
  }

  async appendBatch(inputs: MemoryEventInput[]): Promise<MemoryEvent[]> {
    return serializeLedger(this.eventsPath, async () => {
      await mkdir(this.dirPath, { recursive: true });
      const existing = await readLedger(this.eventsPath);
      if (inputs.length === 0) {
        return [];
      }
      const events = inputs.map((input, index) => this.createEvent(input, existing.length + index + 1));
      if (!events.every((event) => validEventRecord(event))) {
        failLedger();
      }
      await writeDurably(this.eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "a");
      return events;
    });
  }

  async clear(): Promise<void> {
    await serializeLedger(this.eventsPath, async () => {
      await mkdir(this.dirPath, { recursive: true });
      await readLedger(this.eventsPath);
      await writeDurably(this.eventsPath, "", "w");
    });
  }

  async read(query: MemoryStoreQuery = {}): Promise<MemoryEvent[]> {
    return serializeLedger(this.eventsPath, async () => {
      const events = await readLedger(this.eventsPath);
      const queryText = (query.search ?? "").toLowerCase();
      const searchTokens = queryText
        .split(/\W+/u)
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
      const result: MemoryEvent[] = [];
      const wantedTags = (query.tags ?? []).map((tag) => tag.toLowerCase());
      const wantedTypes = query.types;

      for (const event of events) {
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
    });
  }
}
