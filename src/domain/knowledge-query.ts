import { DomainError } from "./errors.js";
import type {
  CanonicalProject,
  EntityId,
  KeyIssue,
  KnowledgeAssociation,
  KnowledgeItem,
  Topic
} from "./types.js";

export type KnowledgeContextTarget =
  | { kind: "topic"; id: EntityId }
  | { kind: "keyIssue"; id: EntityId };

export interface ContextualKnowledgeItem {
  item: KnowledgeItem;
  association: KnowledgeAssociation;
}

export interface KnowledgeSection {
  id: string;
  kind: "pinned" | "publications" | "videos" | "data" | "notes" | "collection" | "tag";
  title: string;
  items: ContextualKnowledgeItem[];
}

export interface KnowledgeContext {
  target: KnowledgeContextTarget;
  entity: Topic | KeyIssue;
  sections: KnowledgeSection[];
}

const publicationTypes = new Set(["article", "attachment", "book", "link", "pdf", "research-paper", "web-link"]);
const videoTypes = new Set(["video"]);
const dataTypes = new Set(["data", "dataset"]);
const noteTypes = new Set(["markdown", "note", "text"]);

function compareContextItems(left: ContextualKnowledgeItem, right: ContextualKnowledgeItem): number {
  return (
    (left.association.order ?? Number.MAX_SAFE_INTEGER) -
      (right.association.order ?? Number.MAX_SAFE_INTEGER) ||
    left.item.title.localeCompare(right.item.title) ||
    left.item.id.localeCompare(right.item.id)
  );
}

function systemSection(
  id: KnowledgeSection["kind"],
  title: string,
  items: ContextualKnowledgeItem[]
): KnowledgeSection {
  return { id, kind: id, title, items: [...items].sort(compareContextItems) };
}

export function queryKnowledgeContext(
  project: CanonicalProject,
  target: KnowledgeContextTarget
): KnowledgeContext {
  const entity =
    target.kind === "topic"
      ? project.topics.find(({ id }) => id === target.id)
      : project.keyIssues.find(({ id }) => id === target.id);
  if (!entity) throw new DomainError("not-found", `${target.kind} ${target.id} does not exist`);

  const itemsById = new Map(project.knowledgeItems.map((item) => [item.id, item]));
  const contextualItems = project.associations
    .filter(({ targetKind, targetId }) => targetKind === target.kind && targetId === target.id)
    .map((association) => {
      const item = itemsById.get(association.knowledgeItemId);
      if (!item) {
        throw new DomainError(
          "invalid-reference",
          `Knowledge Association ${association.id} has no Knowledge Item`
        );
      }
      return { item, association };
    });

  const pinned = contextualItems.filter(({ association }) => association.pinned);
  const unpinned = contextualItems.filter(({ association }) => !association.pinned);
  const categorized = new Set<EntityId>();
  const takeTypes = (types: Set<string>) =>
    unpinned.filter(({ item }) => {
      const matched = types.has(item.type.toLocaleLowerCase());
      if (matched) categorized.add(item.id);
      return matched;
    });

  const publications = takeTypes(publicationTypes);
  const videos = takeTypes(videoTypes);
  const data = takeTypes(dataTypes);
  const notes = takeTypes(noteTypes);
  for (const contextual of unpinned) {
    if (!categorized.has(contextual.item.id)) publications.push(contextual);
  }

  const sections: KnowledgeSection[] = [
    systemSection("pinned", "Pinned", pinned),
    systemSection("publications", "Publications", publications),
    systemSection("videos", "Videos", videos),
    systemSection("data", "Data", data),
    systemSection("notes", "Notes", notes)
  ];

  for (const collection of [...project.collections].sort(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
  )) {
    const items = contextualItems.filter(({ association }) => association.collectionIds?.includes(collection.id));
    if (items.length > 0) {
      sections.push({
        id: `collection:${collection.id}`,
        kind: "collection",
        title: collection.title,
        items: items.sort(compareContextItems)
      });
    }
  }

  const tags = new Map<string, ContextualKnowledgeItem[]>();
  for (const contextual of contextualItems) {
    for (const tag of contextual.item.tags ?? []) {
      const values = tags.get(tag) ?? [];
      values.push(contextual);
      tags.set(tag, values);
    }
  }
  for (const [tag, items] of [...tags].sort(([left], [right]) => left.localeCompare(right))) {
    sections.push({
      id: `tag:${tag}`,
      kind: "tag",
      title: `#${tag}`,
      items: items.sort(compareContextItems)
    });
  }

  return { target, entity, sections };
}
