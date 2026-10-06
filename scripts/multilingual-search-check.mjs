import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteSearchAdapter } from "../dist/server/src/search/sqlite-search-adapter.js";

const timestamp = "2026-09-30T00:00:00.000Z";
const directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-search-check-"));
const topics = [
  ["topic-en", "Frontier model evaluation and safety", ["evaluation"]],
  ["topic-ar", "الذَّكاء الاصطناعي وأخلاقيات النماذج", ["موثوقيَّة"]],
  ["topic-ru", "Ёмкость вычислительных центров и надёжность", ["инфраструктура"]],
  ["topic-mixed", "نماذج GPT для научных исследований", ["GPT"]]
].map(([id, title, tags]) => ({ id, title, tags, createdAt: timestamp, updatedAt: timestamp }));
const project = {
  manifest: {
    format: "outmapper-project",
    formatVersion: 2,
    id: "multilingual-search-check",
    title: "Multilingual Search Check",
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1,
    homeTopicId: "topic-en"
  },
  topics,
  keyIssues: [],
  relationships: [],
  projectLinks: [],
  knowledgeItems: [
    {
      id: "knowledge-filter",
      type: "paper",
      title: "Cross-language retrieval evidence",
      availability: "local",
      authors: ["Анна Ёлкина"],
      source: "مختبر الأبحاث",
      tags: ["موثوقيَّة"],
      createdAt: timestamp,
      updatedAt: timestamp
    }
  ],
  associations: [],
  assets: [],
  collections: [],
  snapshots: []
};

let adapter;
try {
  adapter = SqliteSearchAdapter.open(directory);
  adapter.reconcile(project);
  const cases = [
    ["englishPrefix", { text: "front mod", match: "prefix" }, "topic-en"],
    ["englishPhrase", { text: "frontier model", match: "phrase" }, "topic-en"],
    ["arabicDiacritics", { text: "الذكاء الاصطناعي" }, "topic-ar"],
    ["arabicAlef", { text: "اخلاقيات" }, "topic-ar"],
    ["russianYo", { text: "емк" }, "topic-ru"],
    ["mixedScript", { text: "GPT науч" }, "topic-mixed"],
    ["normalizedFilters", { text: "", filters: { authors: ["анна елкина"], sources: ["مختبر الابحاث"], tags: ["موثوقيه"] } }, "knowledge-filter"]
  ];
  const outcomes = {};
  for (const [name, query, expected] of cases) {
    const result = await adapter.search(query);
    outcomes[name] = result.items.some(({ id }) => id === expected);
  }
  const result = {
    corpusItems: topics.length + project.knowledgeItems.length,
    cases: cases.length,
    outcomes
  };
  result.accepted = Object.values(outcomes).every(Boolean);
  console.log(JSON.stringify(result));
  if (!result.accepted) process.exitCode = 1;
} finally {
  adapter?.close();
  await rm(directory, { recursive: true, force: true });
}
