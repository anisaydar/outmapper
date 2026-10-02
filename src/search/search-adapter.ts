import type { EntityId } from "../domain/types.js";

export type SearchEntityKind = "topic" | "keyIssue" | "knowledgeItem";

export interface SearchFilters {
  entityKinds?: SearchEntityKind[];
  types?: string[];
  topicIds?: EntityId[];
  tags?: string[];
  authors?: string[];
  sources?: string[];
}

export interface SearchQuery {
  text: string;
  match?: "all" | "phrase" | "prefix";
  filters?: SearchFilters;
  cursor?: string;
  limit?: number;
}

export interface SearchContext {
  topicId?: EntityId;
  keyIssueId?: EntityId;
}

export interface SearchHit {
  id: EntityId;
  kind: SearchEntityKind;
  type?: string;
  title: string;
  summary?: string;
  availability?: "local" | "external";
  contexts: SearchContext[];
  score: number;
}

export interface SearchPage {
  items: SearchHit[];
  total: number;
  nextCursor?: string;
}

export interface SearchAdapter {
  search(query: SearchQuery): Promise<SearchPage>;
}
