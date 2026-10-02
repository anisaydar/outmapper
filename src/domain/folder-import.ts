export type FolderFileKind = "pdf" | "note" | "link" | "attachment";
export interface FolderImportFile {
  id: string;
  path: string;
  bytes: number;
  kind?: FolderFileKind;
  duplicate: boolean;
  error?: string;
}
export interface FolderImportPlan {
  id: string;
  folder: string;
  files: FolderImportFile[];
}
export interface FolderImportOptions {
  fileIds: string[];
  target: { kind: "topic" | "keyIssue"; id: string };
  duplicates: "skip" | "keep";
}
export interface FolderImportJob {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed";
  processed: number;
  total: number;
  imported: number;
  skipped: number;
  failures: Array<{ path: string; error: string }>;
  currentFile?: string;
  error?: string;
}
