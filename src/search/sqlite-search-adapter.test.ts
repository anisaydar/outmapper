import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createValidProject, timestamp } from "../test/project-fixtures.js";
import { serializeCanonicalJson } from "../project/serialization.js";
import { DocumentExtractionStore } from "../project/document-extraction-store.js";
import { RUNTIME_DATABASE_PATH, SqliteSearchAdapter, safeFtsExpression } from "./sqlite-search-adapter.js";

describe("native SQLite derived runtime", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-sqlite-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function searchableProject() {
    const project = createValidProject();
    project.knowledgeItems.push({
      id: "knowledge-1",
      type: "article",
      title: "Deterministic reconciliation",
      availability: "external" as const,
      externalUrl: "https://example.org/reconciliation",
      summary: "Canonical files rebuild the disposable runtime index.",
      authors: ["Mira Chen"],
      source: "Runtime Review",
      tags: ["recovery"],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    project.associations.push({
      id: "association-1",
      knowledgeItemId: "knowledge-1",
      targetKind: "keyIssue" as const,
      targetId: "issue-1"
    });
    return project;
  }

  it("rebuilds deterministically after deletion without changing canonical data", async () => {
    const project = searchableProject();
    const before = serializeCanonicalJson(project);
    let adapter = SqliteSearchAdapter.open(directory);
    expect(adapter.reconcile(project).action).toBe("rebuilt");
    expect((await adapter.search({ text: "canonical" })).items[0]).toMatchObject({
      id: "knowledge-1",
      kind: "knowledgeItem",
      contexts: [{ topicId: "topic-1", keyIssueId: "issue-1" }]
    });
    adapter.close();

    await unlink(path.join(directory, RUNTIME_DATABASE_PATH));
    adapter = SqliteSearchAdapter.open(directory);
    expect(adapter.reconcile(project).action).toBe("rebuilt");
    expect((await adapter.search({ text: "canonical" })).items.map(({ id }) => id)).toEqual(["knowledge-1"]);
    adapter.close();
    expect(serializeCanonicalJson(project)).toBe(before);
  });

  it("detects a stale revision and reflects canonical updates through rebuild", async () => {
    const project = searchableProject();
    const adapter = SqliteSearchAdapter.open(directory);
    adapter.reconcile(project);
    project.manifest.revision += 1;
    project.knowledgeItems[0].title = "Updated runtime model";

    expect(adapter.reconcile(project)).toEqual({
      action: "rebuilt",
      canonicalRevision: 1,
      previousRuntimeRevision: 0
    });
    expect((await adapter.search({ text: "updated" })).items[0]?.title).toBe("Updated runtime model");
    adapter.close();
  });

  it("discards and recreates a corrupted runtime database", async () => {
    const databasePath = path.join(directory, RUNTIME_DATABASE_PATH);
    await mkdir(path.dirname(databasePath), { recursive: true });
    await writeFile(databasePath, "not a database", "utf8");
    const adapter = SqliteSearchAdapter.open(directory);

    expect(adapter.reconcile(searchableProject()).action).toBe("rebuilt");
    expect((await adapter.search({ text: "reconciliation" })).total).toBe(1);
    adapter.close();
    expect((await readFile(databasePath)).subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  it("normalizes English, Arabic, Russian, and mixed-language prefix searches without changing titles", async () => {
    const project = searchableProject();
    project.topics.push(
      { id: "topic-ar", title: "الذَّكاء الاصطناعي المسؤول", tags: ["تقييم"], createdAt: timestamp, updatedAt: timestamp },
      { id: "topic-ru", title: "Ёмкость вычислительных центров", tags: ["инфраструктура"], createdAt: timestamp, updatedAt: timestamp },
      { id: "topic-mixed", title: "نماذج GPT для науки", createdAt: timestamp, updatedAt: timestamp }
    );
    const adapter = SqliteSearchAdapter.open(directory);
    adapter.reconcile(project);

    expect((await adapter.search({ text: "recon" })).items.map(({ id }) => id)).toContain("knowledge-1");
    expect((await adapter.search({ text: "الذكاء" })).items[0]).toMatchObject({
      id: "topic-ar",
      title: "الذَّكاء الاصطناعي المسؤول"
    });
    expect((await adapter.search({ text: "емк" })).items[0]?.id).toBe("topic-ru");
    expect((await adapter.search({ text: "GPT наук" })).items[0]?.id).toBe("topic-mixed");
    adapter.close();
  });

  it("supports phrase, prefix, and normalized metadata filters through engine-neutral query fields", async () => {
    const project = searchableProject();
    project.knowledgeItems.push({
      id: "knowledge-phrase",
      type: "paper",
      title: "Frontier model evaluation methods",
      availability: "local",
      authors: ["Анна Ёлкина"],
      source: "مختبر الأبحاث",
      tags: ["موثوقيَّة"],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    const adapter = SqliteSearchAdapter.open(directory);
    adapter.reconcile(project);

    expect((await adapter.search({ text: "frontier model", match: "phrase" })).items.map(({ id }) => id)).toEqual([
      "knowledge-phrase"
    ]);
    expect((await adapter.search({ text: "front mod", match: "prefix" })).items.map(({ id }) => id)).toEqual([
      "knowledge-phrase"
    ]);
    expect((await adapter.search({ text: "", filters: { authors: ["анна елкина"] } })).items[0]?.id).toBe(
      "knowledge-phrase"
    );
    expect((await adapter.search({ text: "", filters: { sources: ["مختبر الابحاث"], tags: ["موثوقيه"] } })).items[0]?.id).toBe(
      "knowledge-phrase"
    );
    adapter.close();
  });

  it("builds deterministic FTS expressions without accepting raw engine syntax", () => {
    expect(safeFtsExpression('model" OR *', "prefix")).toBe('"model"* AND "or"*');
    expect(safeFtsExpression("\"frontier model\"", "phrase")).toBe('"frontier model"');
    expect(() => safeFtsExpression("term ".repeat(33))).toThrow("32 terms");
  });

  it("indexes current derived PDF text and drops stale or corrupt extraction data cleanly", async () => {
    const project = searchableProject();
    project.assets.push({
      id: "asset-pdf",
      path: "assets/asset-pdf/evidence.pdf",
      originalFilename: "evidence.pdf",
      mimeType: "application/pdf",
      byteSize: 100,
      sha256: "c".repeat(64),
      createdAt: timestamp
    });
    project.knowledgeItems[0].attachmentAssetIds = ["asset-pdf"];
    const adapter = SqliteSearchAdapter.open(directory);
    expect(adapter.reconcile(project).action).toBe("rebuilt");
    expect((await adapter.search({ text: "document-only" })).total).toBe(0);
    await new DocumentExtractionStore(directory).write({
      format: "outmapper-derived-document-text",
      formatVersion: 1,
      assetId: "asset-pdf",
      assetSha256: "c".repeat(64),
      extractor: "pdfjs",
      extractorVersion: "6.3.289",
      status: "complete",
      completedAt: timestamp,
      pageCount: 2,
      text: "Document-only evidence from a supported PDF."
    });

    expect(adapter.reconcile(project).action).toBe("rebuilt");
    expect((await adapter.search({ text: "document-only" })).items[0]?.id).toBe("knowledge-1");
    await writeFile(path.join(directory, ".outmapper", "extracted-text", "asset-pdf.json"), "corrupt", "utf8");
    expect(adapter.reconcile(project).action).toBe("rebuilt");
    expect((await adapter.search({ text: "document-only" })).total).toBe(0);
    adapter.close();
  });
});
