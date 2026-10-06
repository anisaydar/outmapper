import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { SearchContext, SearchEntityKind, SearchFilters, SearchHit, SearchPage, SearchQuery } from "./search-adapter.js";
import { normalizeSearchText, safeFtsExpression, SEARCH_SCHEMA_VERSION } from "./sqlite-search-adapter.js";
import type { WorkspaceSearchProject, WorkspaceSearchWork } from "./workspace-search.js";

interface WorkerRequest extends WorkspaceSearchWork {
  id: number;
  cancellation: SharedArrayBuffer;
}

interface CandidateRow {
  entity_id: string;
  kind: SearchEntityKind;
  type: string;
  title: string;
  body: string;
  availability: "" | "local" | "external";
  contexts_json: string;
  rank: number;
}

interface RankedHit extends SearchHit {
  tier: number;
  reciprocalRank: number;
  projectOrder: number;
  lastOpenedAt: string;
  current: boolean;
}

interface ProjectResult {
  hits: RankedHit[];
  total: number;
  stale: boolean;
  searchable: boolean;
}

const connections = new Map<string, DatabaseSync>();
const CONNECTION_LIMIT = 32;

function cancelled(flag: Int32Array): boolean {
  return Atomics.load(flag, 0) === 1;
}

function sqliteCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function withBusyRetry<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (sqliteCode(error) !== "ERR_SQLITE_ERROR" && sqliteCode(error) !== "SQLITE_BUSY") throw error;
    if (!/busy|locked/iu.test(error instanceof Error ? error.message : "")) throw error;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    return operation();
  }
}

function connection(databasePath: string): DatabaseSync {
  const current = connections.get(databasePath);
  if (current) {
    connections.delete(databasePath);
    connections.set(databasePath, current);
    return current;
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  connections.set(databasePath, database);
  if (connections.size > CONNECTION_LIMIT) {
    const oldest = connections.entries().next().value as [string, DatabaseSync] | undefined;
    if (oldest) {
      connections.delete(oldest[0]);
      oldest[1].close();
    }
  }
  return database;
}

function metadata(database: DatabaseSync): Map<string, string> {
  const rows = withBusyRetry(() => database.prepare("SELECT key, value FROM runtime_meta").all()) as unknown as Array<{ key: string; value: string }>;
  return new Map(rows.map(({ key, value }) => [key, value]));
}

function filtersFor(filters: SearchFilters | undefined): { where: string; parameters: Array<string | number> } {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  const addList = (column: string, values: string[] | undefined) => {
    if (!values?.length) return;
    conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    parameters.push(...values);
  };
  addList("e.kind", filters?.entityKinds);
  addList("e.type", filters?.types);
  if (filters?.topicIds?.length) {
    conditions.push(`(${filters.topicIds.map(() => "e.contexts_json LIKE ? ESCAPE '\\\\'").join(" OR ")})`);
    parameters.push(...filters.topicIds.map((id) => `%"topicId":"${id.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}"%`));
  }
  const addText = (column: string, values: string[] | undefined) => {
    if (!values?.length) return;
    conditions.push(`(${values.map(() => `lower(${column}) LIKE ?`).join(" OR ")})`);
    parameters.push(...values.map((value) => `%${normalizeSearchText(value)}%`));
  };
  addText("e.tags_normalized", filters?.tags);
  addText("e.authors_normalized", filters?.authors);
  addText("e.source_normalized", filters?.sources);
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", parameters };
}

function tierFor(title: string, normalizedQuery: string): number {
  const normalizedTitle = normalizeSearchText(title).trim().replace(/\s+/gu, " ");
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 1;
  if (normalizedTitle.includes(normalizedQuery)) return 2;
  return 3;
}

function projectSearch(database: DatabaseSync, project: WorkspaceSearchProject, query: SearchQuery, projectOrder: number): ProjectResult {
  const meta = metadata(database);
  if (meta.get("searchSchemaVersion") !== SEARCH_SCHEMA_VERSION || meta.get("projectId") !== project.projectId) {
    return { hits: [], total: 0, stale: false, searchable: false };
  }
  const runtimeRevisionValue = meta.get("canonicalRevision");
  const runtimeRevision = Number(runtimeRevisionValue);
  if (!runtimeRevisionValue || !/^(?:0|[1-9]\d*)$/u.test(runtimeRevisionValue) || !Number.isSafeInteger(runtimeRevision)) {
    return { hits: [], total: 0, stale: false, searchable: false };
  }
  const stale = runtimeRevision < project.canonicalRevision;
  const normalizedQuery = normalizeSearchText(query.text).trim().replace(/\s+/gu, " ");
  const filter = filtersFor(query.filters);
  const selectColumns = "e.entity_id, e.kind, e.type, e.title, e.body, e.availability, e.contexts_json";
  const rows = new Map<string, CandidateRow>();
  const addRows = (candidates: CandidateRow[]) => {
    for (const row of candidates) rows.set(`${row.kind}:${row.entity_id}`, row);
  };
  const expression = safeFtsExpression(query.text, query.match ?? "prefix");
  if (expression) {
    const joinWhere = filter.where ? `${filter.where} AND search_fts MATCH ?` : "WHERE search_fts MATCH ?";
    const fts = withBusyRetry(() => database.prepare(`
      SELECT ${selectColumns}, bm25(search_fts) AS rank
      FROM search_fts JOIN search_entities e ON e.row_key = search_fts.row_key
      ${joinWhere}
      ORDER BY rank ASC, e.kind ASC, e.title COLLATE NOCASE ASC, e.entity_id ASC
      LIMIT 250
    `).all(...filter.parameters, expression)) as unknown as CandidateRow[];
    addRows(fts);
  }
  const titleRows = withBusyRetry(() => database.prepare(`
    SELECT ${selectColumns}, 0 AS rank
    FROM search_entities e ${filter.where}
    ORDER BY e.title COLLATE NOCASE ASC, e.entity_id ASC
    LIMIT 1000
  `).all(...filter.parameters)) as unknown as CandidateRow[];
  addRows(titleRows.filter(({ title }) => !normalizedQuery || normalizeSearchText(title).includes(normalizedQuery)));

  const ordered = [...rows.values()]
    .map((row) => ({ row, tier: normalizedQuery ? tierFor(row.title, normalizedQuery) : 3 }))
    .sort((left, right) =>
      left.tier - right.tier ||
      left.row.rank - right.row.rank ||
      left.row.kind.localeCompare(right.row.kind) ||
      left.row.title.localeCompare(right.row.title) ||
      left.row.entity_id.localeCompare(right.row.entity_id));
  const tierRanks = new Map<number, number>();
  const hits = ordered.slice(0, 10).map(({ row, tier }) => {
    const tierRank = (tierRanks.get(tier) ?? 0) + 1;
    tierRanks.set(tier, tierRank);
    return {
      id: row.entity_id,
      kind: row.kind,
      ...(row.kind === "knowledgeItem" ? { type: row.type } : {}),
      title: row.title,
      ...(row.body ? { summary: row.body.slice(0, 280) } : {}),
      ...(row.availability ? { availability: row.availability } : {}),
      contexts: JSON.parse(row.contexts_json) as SearchContext[],
      score: (4 - tier) * 1000 + 1 / (60 + tierRank),
      sourceInstanceId: project.instanceId,
      sourceProjectId: project.projectId,
      sourceProjectTitle: project.projectTitle,
      ...(stale ? { mayBeOutOfDate: true } : {}),
      tier,
      reciprocalRank: 1 / (60 + tierRank),
      projectOrder,
      lastOpenedAt: project.lastOpenedAt ?? "",
      current: project.current
    } satisfies RankedHit;
  });
  return { hits, total: ordered.length, stale, searchable: true };
}

function stripRanking(hit: RankedHit): SearchHit {
  const result: Partial<RankedHit> = { ...hit };
  delete result.tier;
  delete result.reciprocalRank;
  delete result.projectOrder;
  delete result.lastOpenedAt;
  delete result.current;
  return result as SearchHit;
}

function run(request: WorkerRequest): SearchPage {
  const flag = new Int32Array(request.cancellation);
  const startIndex = Math.max(0, Math.min(request.projects.length, Math.trunc(request.startIndex ?? 0)));
  const budgetMs = Math.max(0, request.budgetMs ?? 400);
  const started = performance.now();
  const hits: RankedHit[] = [];
  let total = 0;
  let notSearchableCount = 0;
  let staleProjectCount = 0;
  let nextIndex = request.projects.length;

  for (let index = startIndex; index < request.projects.length; index += 1) {
    if (cancelled(flag)) throw Object.assign(new Error("Search was cancelled"), { code: "search-cancelled" });
    const project = request.projects[index]!;
    let result: ProjectResult;
    if (!existsSync(project.databasePath)) {
      result = { hits: [], total: 0, stale: false, searchable: false };
    } else {
      try {
        result = projectSearch(connection(project.databasePath), project, request.query, index);
      } catch (error) {
        if (/busy|locked/iu.test(error instanceof Error ? error.message : "")) {
          result = { hits: [], total: 0, stale: false, searchable: false };
        } else if (/no such table|file is not a database|malformed|unable to open/iu.test(error instanceof Error ? error.message : "")) {
          result = { hits: [], total: 0, stale: false, searchable: false };
        } else throw error;
      }
    }
    if (!result.searchable) notSearchableCount += 1;
    else {
      hits.push(...result.hits);
      total += result.total;
      if (result.stale) staleProjectCount += 1;
    }
    if (index + 1 < request.projects.length && performance.now() - started >= budgetMs) {
      nextIndex = index + 1;
      break;
    }
  }
  hits.sort((left, right) =>
    left.tier - right.tier ||
    right.reciprocalRank - left.reciprocalRank ||
    Number(right.current) - Number(left.current) ||
    right.lastOpenedAt.localeCompare(left.lastOpenedAt) ||
    left.projectOrder - right.projectOrder ||
    left.kind.localeCompare(right.kind) ||
    left.title.localeCompare(right.title) ||
    left.id.localeCompare(right.id));
  const limited = hits.slice(0, 50).map(stripRanking);
  const incomplete = nextIndex < request.projects.length;
  return {
    items: limited,
    total: Math.min(50, total),
    ...(total > 50 ? { totalCapped: true } : {}),
    ...(incomplete ? { incomplete: true, continuation: String(nextIndex) } : {}),
    ...(notSearchableCount ? { notSearchableCount } : {}),
    ...(staleProjectCount ? { staleProjectCount } : {})
  };
}

const port = parentPort;
if (!port) throw new Error("Workspace search worker requires a parent port");
port.on("message", (request: WorkerRequest) => {
  try {
    port.postMessage({ id: request.id, page: run(request) });
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: {
        code: error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "workspace-search-failed",
        message: error instanceof Error ? error.message : "Workspace search failed"
      }
    });
  }
});
