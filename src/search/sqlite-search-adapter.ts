import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CanonicalProject, EntityId } from "../domain/types.js";
import { readCurrentDocumentText } from "../project/document-extraction-store.js";
import type {
  SearchAdapter,
  SearchContext,
  SearchEntityKind,
  SearchFilters,
  SearchHit,
  SearchPage,
  SearchQuery
} from "./search-adapter.js";

export const RUNTIME_DATABASE_PATH = ".outmapper/runtime.sqlite";
const SEARCH_SCHEMA_VERSION = "2";

export interface RuntimeReconciliation {
  action: "current" | "rebuilt";
  canonicalRevision: number;
  previousRuntimeRevision: number | null;
}

interface IndexedRecord {
  rowKey: string;
  entityId: EntityId;
  kind: SearchEntityKind;
  type: string;
  title: string;
  body: string;
  authors: string;
  source: string;
  tags: string;
  availability: "" | "local" | "external";
  contexts: SearchContext[];
}

interface SearchRow {
  entity_id: string;
  kind: SearchEntityKind;
  type: string;
  title: string;
  body: string;
  availability: "" | "local" | "external";
  contexts_json: string;
  rank: number;
}

function deleteRuntimeFiles(databasePath: string): void {
  for (const candidate of [databasePath, `${databasePath}-shm`, `${databasePath}-wal`]) {
    if (existsSync(candidate)) unlinkSync(candidate);
  }
}

export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu, "")
    .replace(/ـ/gu, "")
    .replace(/[أإآٱ]/gu, "ا")
    .replace(/ى/gu, "ي")
    .replace(/ة/gu, "ه")
    .replace(/ё/gu, "е");
}

function searchTokenVariants(token: string): string[] {
  const variants = new Set([token]);
  if (/^[\u0600-\u06ff]{5,}$/u.test(token) && /^[وفبكل]/u.test(token)) variants.add(token.slice(1));
  for (const value of [...variants]) {
    if (value.length >= 5 && value.startsWith("ال")) variants.add(value.slice(2));
  }
  return [...variants];
}

function normalizeIndexedText(text: string): string {
  const normalized = normalizeSearchText(text);
  const tokens: string[] = normalized.match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  const variants = tokens.flatMap(searchTokenVariants).filter((value) => !tokens.includes(value));
  return variants.length ? `${normalized} ${variants.join(" ")}` : normalized;
}

export function safeFtsExpression(text: string, match: SearchQuery["match"] = "prefix"): string | null {
  if (text.length > 500) throw new Error("Search text cannot exceed 500 characters");
  const tokens: string[] = normalizeSearchText(text).match(/[\p{L}\p{M}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  if (tokens.length > 32) throw new Error("Search text cannot exceed 32 terms");
  if (match === "phrase") return `"${tokens.join(" ")}"`;
  return tokens
    .map((token) => {
      const terms = searchTokenVariants(token).map((value) => `"${value}"${match === "prefix" ? "*" : ""}`);
      return terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;
    })
    .join(" AND ");
}

function createIndexedRecords(project: CanonicalProject, documentText: Map<string, string>): IndexedRecord[] {
  const records: IndexedRecord[] = [];
  for (const topic of project.topics) {
    records.push({
      rowKey: `topic:${topic.id}`,
      entityId: topic.id,
      kind: "topic",
      type: "topic",
      title: topic.title,
      body: topic.description ?? "",
      authors: "",
      source: "",
      tags: (topic.tags ?? []).join(" "),
      availability: "",
      contexts: [{ topicId: topic.id }]
    });
  }
  for (const issue of project.keyIssues) {
    records.push({
      rowKey: `keyIssue:${issue.id}`,
      entityId: issue.id,
      kind: "keyIssue",
      type: "keyIssue",
      title: issue.title,
      body: issue.description ?? "",
      authors: "",
      source: "",
      tags: "",
      availability: "",
      contexts: [{ topicId: issue.topicId, keyIssueId: issue.id }]
    });
  }
  const associationsByItem = new Map<EntityId, SearchContext[]>();
  for (const association of project.associations) {
    const contexts = associationsByItem.get(association.knowledgeItemId) ?? [];
    contexts.push(
      association.targetKind === "topic"
        ? { topicId: association.targetId }
        : {
            topicId: project.keyIssues.find(({ id }) => id === association.targetId)?.topicId,
            keyIssueId: association.targetId
          }
    );
    associationsByItem.set(association.knowledgeItemId, contexts);
  }
  for (const item of project.knowledgeItems) {
    const contexts = (associationsByItem.get(item.id) ?? []).sort(
      (left, right) =>
        (left.topicId ?? "").localeCompare(right.topicId ?? "") ||
        (left.keyIssueId ?? "").localeCompare(right.keyIssueId ?? "")
    );
    records.push({
      rowKey: `knowledgeItem:${item.id}`,
      entityId: item.id,
      kind: "knowledgeItem",
      type: item.type,
      title: item.title,
      body: [
        item.summary,
        item.body,
        ...(item.attachmentAssetIds ?? []).map((assetId) => documentText.get(assetId))
      ].filter(Boolean).join("\n"),
      authors: (item.authors ?? []).join(" "),
      source: item.source ?? "",
      tags: (item.tags ?? []).join(" "),
      availability: item.availability,
      contexts
    });
  }
  return records.sort((left, right) => left.rowKey.localeCompare(right.rowKey));
}

export class SqliteSearchAdapter implements SearchAdapter {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  private constructor(databasePath: string, database: DatabaseSync) {
    this.databasePath = databasePath;
    this.database = database;
    this.initialize();
  }

  static open(projectDirectory: string): SqliteSearchAdapter {
    const databasePath = path.resolve(projectDirectory, RUNTIME_DATABASE_PATH);
    mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
      return new SqliteSearchAdapter(databasePath, database);
    } catch {
      database.close();
      deleteRuntimeFiles(databasePath);
      return new SqliteSearchAdapter(databasePath, new DatabaseSync(databasePath));
    }
  }

  reconcile(project: CanonicalProject): RuntimeReconciliation {
    const runtimeProjectId = this.readMetadata("projectId");
    const runtimeRevisionValue = this.readMetadata("canonicalRevision");
    const runtimeRevision = runtimeRevisionValue === null ? null : Number(runtimeRevisionValue);
    const documentText = readCurrentDocumentText(path.dirname(path.dirname(this.databasePath)), project);
    const runtimeDocumentRevision = this.readMetadata("documentTextRevision");
    if (
      runtimeProjectId === project.manifest.id &&
      runtimeRevision === project.manifest.revision &&
      runtimeDocumentRevision === documentText.revision
    ) {
      return {
        action: "current",
        canonicalRevision: project.manifest.revision,
        previousRuntimeRevision: runtimeRevision
      };
    }

    const records = createIndexedRecords(project, documentText.textByAssetId);
    const insertEntity = this.database.prepare(`
      INSERT INTO search_entities
        (row_key, entity_id, kind, type, title, body, authors, source, tags,
         authors_normalized, source_normalized, tags_normalized, availability, contexts_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.database.prepare(
      "INSERT INTO search_fts (row_key, title, body, authors, source, tags) VALUES (?, ?, ?, ?, ?, ?)"
    );
    const setMetadata = this.database.prepare(
      "INSERT INTO runtime_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );

    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM search_fts; DELETE FROM search_entities; DELETE FROM runtime_meta;");
      for (const record of records) {
        insertEntity.run(
          record.rowKey,
          record.entityId,
          record.kind,
          record.type,
          record.title,
          record.body,
          record.authors,
          record.source,
          record.tags,
          normalizeSearchText(record.authors),
          normalizeSearchText(record.source),
          normalizeSearchText(record.tags),
          record.availability,
          JSON.stringify(record.contexts)
        );
        insertFts.run(
          record.rowKey,
          normalizeIndexedText(record.title),
          normalizeIndexedText(record.body),
          normalizeIndexedText(record.authors),
          normalizeIndexedText(record.source),
          normalizeIndexedText(record.tags)
        );
      }
      setMetadata.run("searchSchemaVersion", SEARCH_SCHEMA_VERSION);
      setMetadata.run("projectId", project.manifest.id);
      setMetadata.run("canonicalRevision", String(project.manifest.revision));
      setMetadata.run("documentTextRevision", documentText.revision);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return {
      action: "rebuilt",
      canonicalRevision: project.manifest.revision,
      previousRuntimeRevision: Number.isFinite(runtimeRevision) ? runtimeRevision : null
    };
  }

  async search(query: SearchQuery): Promise<SearchPage> {
    const requestedLimit = Number.isFinite(query.limit) ? Math.trunc(query.limit ?? 25) : 25;
    const limit = Math.max(1, Math.min(100, requestedLimit));
    const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
    const expression = safeFtsExpression(query.text, query.match);
    const filters = this.buildFilters(query.filters);
    const from = expression
      ? "FROM search_fts JOIN search_entities e ON e.row_key = search_fts.row_key"
      : "FROM search_entities e";
    const conditions = [...filters.conditions];
    const parameters: Array<string | number> = [...filters.parameters];
    if (expression) {
      conditions.unshift("search_fts MATCH ?");
      parameters.unshift(expression);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rank = expression ? "bm25(search_fts)" : "0";
    const rows = this.database
      .prepare(
        `SELECT e.entity_id, e.kind, e.type, e.title, e.body, e.availability, e.contexts_json,
                ${rank} AS rank
           ${from}
           ${where}
          ORDER BY rank ASC, e.kind ASC, e.title COLLATE NOCASE ASC, e.entity_id ASC
          LIMIT ? OFFSET ?`
      )
      .all(...parameters, limit, offset) as unknown as SearchRow[];
    const count = this.database
      .prepare(`SELECT count(*) AS total ${from} ${where}`)
      .get(...parameters) as unknown as { total: number };
    const items: SearchHit[] = rows.map((row) => ({
      id: row.entity_id,
      kind: row.kind,
      ...(row.kind === "knowledgeItem" ? { type: row.type } : {}),
      title: row.title,
      ...(row.body ? { summary: row.body.slice(0, 280) } : {}),
      ...(row.availability ? { availability: row.availability } : {}),
      contexts: JSON.parse(row.contexts_json) as SearchContext[],
      score: expression ? -row.rank : 0
    }));
    return {
      items,
      total: count.total,
      ...(offset + items.length < count.total ? { nextCursor: String(offset + items.length) } : {})
    };
  }

  close(): void {
    this.database.close();
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS runtime_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    if (this.readMetadata("searchSchemaVersion") !== SEARCH_SCHEMA_VERSION) {
      this.database.exec("DROP TABLE IF EXISTS search_fts; DROP TABLE IF EXISTS search_entities; DELETE FROM runtime_meta;");
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS search_entities (
        row_key TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        authors TEXT NOT NULL,
        source TEXT NOT NULL,
        tags TEXT NOT NULL,
        authors_normalized TEXT NOT NULL,
        source_normalized TEXT NOT NULL,
        tags_normalized TEXT NOT NULL,
        availability TEXT NOT NULL,
        contexts_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        row_key UNINDEXED,
        title,
        body,
        authors,
        source,
        tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    this.database
      .prepare("INSERT INTO runtime_meta (key, value) VALUES ('searchSchemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(SEARCH_SCHEMA_VERSION);
  }

  private readMetadata(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM runtime_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private buildFilters(filters: SearchFilters | undefined): {
    conditions: string[];
    parameters: Array<string | number>;
  } {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    const addList = (column: string, values: string[] | undefined) => {
      if (!values || values.length === 0) return;
      conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
      parameters.push(...values);
    };
    addList("e.kind", filters?.entityKinds);
    addList("e.type", filters?.types);
    if (filters?.topicIds?.length) {
      conditions.push(`(${filters.topicIds.map(() => "e.contexts_json LIKE ? ESCAPE '\\'").join(" OR ")})`);
      parameters.push(
        ...filters.topicIds.map((id) => {
          const escaped = id.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
          return `%"topicId":"${escaped}"%`;
        })
      );
    }
    const addTextFilter = (column: string, values: string[] | undefined) => {
      if (!values || values.length === 0) return;
      conditions.push(`(${values.map(() => `lower(${column}) LIKE ?`).join(" OR ")})`);
      parameters.push(...values.map((value) => `%${normalizeSearchText(value)}%`));
    };
    addTextFilter("e.tags_normalized", filters?.tags);
    addTextFilter("e.authors_normalized", filters?.authors);
    addTextFilter("e.source_normalized", filters?.sources);
    return { conditions, parameters };
  }
}
