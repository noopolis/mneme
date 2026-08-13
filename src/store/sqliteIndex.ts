import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { JsonlMemoryStore } from "./store.js";
import { canonicalScopeKey } from "../identity/ids.js";
import { type MemoryIndexEmbeddingQuery, rankEventsByEmbedding } from "./embeddingSearch.js";
import type {
  MemoryEvent,
  MemoryEventType,
  MemoryPrincipalRef
} from "../contract/types.js";

export interface MemoryIndexQuery {
  allowedScopes?: string[];
  query?: string;
  tags?: string[];
  entities?: string[];
  types?: MemoryEventType[];
  principalAgentId?: string;
  principalScope?: MemoryPrincipalRef["scope"];
  principalQualifier?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryIndexSearchResult {
  event: MemoryEvent;
  score: number;
}

interface RawIndexRow {
  event_json: string;
  score: number;
  created_at: string;
  event_id: string;
  checksum: string;
}

const defaultIndexFileName = "index.sqlite";

const normalizeScope = (scope?: string): string => canonicalScopeKey(scope);

const uniqueSorted = (values: string[]): string[] =>
  [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();

const splitQueryTokens = (query: string): string[] => {
  return uniqueSorted(query.split(/[^a-z0-9]+/u).filter((value) => value.length >= 2));
};

const escapeLikeTerm = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

const placeholders = (count: number): string => new Array(count).fill("?").join(", ");

export interface SQLiteIndexConfig {
  runtimeHomePath: string;
  indexFilePath?: string;
}

export class SQLiteMemoryIndex {
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private ftsEnabled: boolean | undefined;

  constructor(options: SQLiteIndexConfig) {
    const memoryPath = path.join(options.runtimeHomePath, "memory");
    mkdirSync(memoryPath, { recursive: true });
    this.dbPath = options.indexFilePath ?? path.join(memoryPath, defaultIndexFileName);
    this.db = new DatabaseSync(this.dbPath);
  }

  async rebuildFromStore(): Promise<void> {
    const events = await new JsonlMemoryStore(path.dirname(path.dirname(this.dbPath))).read();
    await this.rebuildFromEvents(events);
  }

  async rebuildFromEvents(events: MemoryEvent[]): Promise<void> {
    this.rebuildSchema(events);
  }

  async query(input: MemoryIndexQuery): Promise<MemoryIndexSearchResult[]> {
    return this.runQuery(input);
  }

  async queryByEmbedding(input: MemoryIndexEmbeddingQuery): Promise<MemoryIndexSearchResult[]> {
    const candidateLimit = Number.isFinite(input.limit ?? Number.NaN) && (input.limit ?? 0) > 0
      ? Math.max(1, Math.floor(input.limit as number))
      : 100;
    const scored = await rankEventsByEmbedding(this.runQuery({
      allowedScopes: input.allowedScopes,
      tags: input.tags,
      entities: input.entities,
      types: input.types,
      principalAgentId: input.principalAgentId,
      principalScope: input.principalScope,
      principalQualifier: input.principalQualifier,
      limit: Math.max(candidateLimit * 5, 120)
    }).map((entry) => entry.event), input.queryVector, input.embeddingProvider);
    const start = Number.isFinite(input.offset ?? Number.NaN) && (input.offset ?? 0) > 0
      ? Math.floor(input.offset as number)
      : 0;
    const effective = Math.max(1, Number.isFinite(input.limit ?? Number.NaN) && (input.limit ?? 0) > 0
      ? Math.floor(input.limit as number)
      : 100);
    return scored.sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const timeDelta = Date.parse(right.event.createdAt) - Date.parse(left.event.createdAt);
      if (timeDelta !== 0) {
        return timeDelta;
      }

      const scopeDelta = left.event.scope.localeCompare(right.event.scope);
      if (scopeDelta !== 0) {
        return scopeDelta;
      }

      const idDelta = left.event.id.localeCompare(right.event.id);
      return idDelta !== 0 ? idDelta : left.event.checksum.localeCompare(right.event.checksum);
    }).slice(start, start + effective);
  }

  close(): void {
    this.db.close();
  }

  private useFtsFallback(): boolean {
    if (this.ftsEnabled === undefined) {
      this.ftsEnabled = this.detectFts();
    }
    return this.ftsEnabled;
  }

  private detectFts(): boolean {
    try {
      this.db.exec("CREATE VIRTUAL TABLE memory_events_fts_probe USING fts5(term)");
      this.db.exec("DROP TABLE memory_events_fts_probe");
      return true;
    } catch (_error) {
      return false;
    }
  }

  private rebuildSchema(events: MemoryEvent[]): void {
    const normalized = [...events]
      .map((event) => {
        const scope = normalizeScope(event.scope);
        const tags = uniqueSorted(event.tags ?? []);
        const entities = uniqueSorted(event.entities ?? []);
        const searchable = JSON.stringify({
          id: event.id,
          type: event.type,
          scope,
          principal: event.principal,
          visibility: event.visibility,
          sensitivity: event.sensitivity,
          source: event.source,
          tags,
          entities,
          content: event.content
        }).toLowerCase();

        return {
          event,
          eventId: event.id,
          checksum: event.checksum,
          createdAt: event.createdAt,
          scope,
          tags,
          entities,
          searchable,
        };
      })
      .sort((left, right) => {
        const createdAt = Date.parse(right.createdAt) - Date.parse(left.createdAt);
        if (createdAt !== 0) {
          return createdAt;
        }
        const scopeDelta = left.scope.localeCompare(right.scope);
        if (scopeDelta !== 0) {
          return scopeDelta;
        }
        const idDelta = left.eventId.localeCompare(right.eventId);
        if (idDelta !== 0) {
          return idDelta;
        }
        return left.checksum.localeCompare(right.checksum);
      });

    const useFts = this.useFtsFallback();
    this.db.exec("BEGIN");
    try {
      this.db.exec("DROP TABLE IF EXISTS memory_event_entities");
      this.db.exec("DROP TABLE IF EXISTS memory_event_tags");
      this.db.exec("DROP TABLE IF EXISTS memory_events_fts");
      this.db.exec("DROP TABLE IF EXISTS memory_events");
      this.db.exec(`CREATE TABLE memory_events (
        event_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        type TEXT NOT NULL,
        principal_agent_id TEXT NOT NULL,
        principal_scope TEXT NOT NULL,
        principal_qualifier TEXT,
        visibility TEXT NOT NULL,
        sensitivity TEXT NOT NULL,
        source TEXT NOT NULL,
        checksum TEXT NOT NULL,
        searchable_text TEXT NOT NULL,
        event_json TEXT NOT NULL
      )`);
      this.db.exec("CREATE INDEX memory_events_scope_idx ON memory_events(scope)");
      this.db.exec("CREATE INDEX memory_events_type_idx ON memory_events(type)");
      this.db.exec("CREATE INDEX memory_events_principal_agent_idx ON memory_events(principal_agent_id)");
      this.db.exec("CREATE INDEX memory_events_principal_scope_idx ON memory_events(principal_scope)");
      this.db.exec("CREATE INDEX memory_events_principal_qualifier_idx ON memory_events(principal_qualifier)");
      this.db.exec("CREATE TABLE memory_event_tags (event_id TEXT NOT NULL, tag TEXT NOT NULL)");
      this.db.exec("CREATE TABLE memory_event_entities (event_id TEXT NOT NULL, entity TEXT NOT NULL)");
      this.db.exec("CREATE INDEX memory_event_tags_event_idx ON memory_event_tags(event_id)");
      this.db.exec("CREATE INDEX memory_event_tags_tag_idx ON memory_event_tags(tag)");
      this.db.exec("CREATE INDEX memory_event_entities_event_idx ON memory_event_entities(event_id)");
      this.db.exec("CREATE INDEX memory_event_entities_entity_idx ON memory_event_entities(entity)");
      if (useFts) {
        this.db.exec(`CREATE VIRTUAL TABLE memory_events_fts USING fts5(event_id UNINDEXED, text)`);
      }

      const insertEvent = this.db.prepare(`
        INSERT INTO memory_events
        (event_id, created_at, scope, type, principal_agent_id, principal_scope, principal_qualifier, visibility, sensitivity, source, checksum, searchable_text, event_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertTag = this.db.prepare(`
        INSERT INTO memory_event_tags (event_id, tag)
        VALUES (?, ?)
      `);
      const insertEntity = this.db.prepare(`
        INSERT INTO memory_event_entities (event_id, entity)
        VALUES (?, ?)
      `);
      const insertFts = useFts ? this.db.prepare(`
        INSERT INTO memory_events_fts (event_id, text)
        VALUES (?, ?)
      `) : undefined;

      for (const event of normalized) {
        const rawEvent = event.event;
        insertEvent.run(
          rawEvent.id,
          rawEvent.createdAt,
          event.scope,
          rawEvent.type,
          rawEvent.principal.agentId,
          rawEvent.principal.scope,
          rawEvent.principal.qualifier ?? null,
          rawEvent.visibility,
          rawEvent.sensitivity,
          rawEvent.source,
          rawEvent.checksum,
          event.searchable,
          JSON.stringify(rawEvent)
        );

        for (const tag of event.tags) {
          insertTag.run(rawEvent.id, tag);
        }

        for (const entity of event.entities) {
          insertEntity.run(rawEvent.id, entity);
        }

        insertFts?.run(rawEvent.id, event.searchable);
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private runQuery(input: MemoryIndexQuery): MemoryIndexSearchResult[] {
    const where: string[] = [];
    const whereParams: string[] = [];
    const scoreParams: string[] = [];

    const allowedScopes = uniqueSorted((input.allowedScopes ?? []).map(normalizeScope).filter(Boolean));
    if (allowedScopes.length > 0) {
      where.push(`e.scope IN (${placeholders(allowedScopes.length)})`);
      whereParams.push(...allowedScopes);
    }

    const types = uniqueSorted(input.types ?? []);
    if (types.length > 0) {
      where.push(`e.type IN (${placeholders(types.length)})`);
      whereParams.push(...types);
    }

    if (input.principalAgentId) {
      where.push("e.principal_agent_id = ?");
      whereParams.push(input.principalAgentId);
    }

    if (input.principalScope) {
      where.push("e.principal_scope = ?");
      whereParams.push(input.principalScope);
    }

    if (input.principalQualifier) {
      where.push("e.principal_qualifier = ?");
      whereParams.push(input.principalQualifier);
    }

    const tags = uniqueSorted(input.tags ?? []);
    if (tags.length > 0) {
      where.push(`
        e.event_id IN (
          SELECT event_id
          FROM memory_event_tags
          WHERE tag IN (${placeholders(tags.length)})
          GROUP BY event_id
          HAVING COUNT(DISTINCT tag) = ${tags.length}
        )
      `);
      whereParams.push(...tags);
    }

    const entities = uniqueSorted(input.entities ?? []);
    if (entities.length > 0) {
      where.push(`
        e.event_id IN (
          SELECT event_id
          FROM memory_event_entities
          WHERE entity IN (${placeholders(entities.length)})
          GROUP BY event_id
          HAVING COUNT(DISTINCT entity) = ${entities.length}
        )
      `);
      whereParams.push(...entities);
    }

    const queryTokens = splitQueryTokens(input.query ?? "");
    let searchScore = "0";
    if (queryTokens.length > 0) {
      if (this.useFtsFallback() && this.tableExists("memory_events_fts")) {
        const match = queryTokens.map((token) => `${token}*`).join(" ");
        where.push(`e.event_id IN (SELECT event_id FROM memory_events_fts WHERE memory_events_fts MATCH ?)`);
        whereParams.push(match);
        searchScore = "1.0";
      } else {
        const scoreParts: string[] = [];
        for (const token of queryTokens) {
          const like = `%${escapeLikeTerm(token)}%`;
          where.push(`LOWER(e.searchable_text) LIKE ? ESCAPE '\\'`);
          whereParams.push(like);
          scoreParts.push("CASE WHEN LOWER(e.searchable_text) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END");
          scoreParams.push(like);
        }
        searchScore = `(${scoreParts.join(" + ")})`;
      }
    }

    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const orderBy = "ORDER BY score DESC, e.created_at DESC, e.scope ASC, e.event_id ASC, e.checksum ASC";
    const limit = input.limit ?? 100;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 100;
    const offset = input.offset ?? 0;
    const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

    const statement = this.db.prepare(`
      SELECT
        e.event_json AS event_json,
        ${searchScore} AS score
      FROM memory_events e
      ${clause}
      GROUP BY e.event_id
      ${orderBy}
      LIMIT ${safeLimit}
      OFFSET ${safeOffset}
    `);

    const rows = statement.all(...scoreParams, ...whereParams) as unknown as RawIndexRow[];
    return rows.map((row) => ({
      event: JSON.parse(row.event_json) as MemoryEvent,
      score: Number(row.score)
    }));
  }

  private tableExists(tableName: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as
      | { name: string | null }
      | undefined;
    return Boolean(row?.name);
  }
}

export const createMemoryIndex = (options: SQLiteIndexConfig): SQLiteMemoryIndex => new SQLiteMemoryIndex(options);
