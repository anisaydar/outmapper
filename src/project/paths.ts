import path from "node:path";

export class ProjectPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectPathError";
  }
}

export function normalizeProjectPath(logicalPath: string): string {
  if (!logicalPath || logicalPath.includes("\0")) {
    throw new ProjectPathError("Project path must be a non-empty relative path");
  }

  const slashPath = logicalPath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(slashPath) || path.win32.isAbsolute(logicalPath)) {
    throw new ProjectPathError("Absolute Project paths are not allowed");
  }

  const parts = slashPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ProjectPathError("Project paths cannot contain empty, current, or parent segments");
  }

  return parts.join("/");
}

export function resolveProjectPath(projectRoot: string, logicalPath: string): string {
  const normalized = normalizeProjectPath(logicalPath);
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(root, ...normalized.split("/"));
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProjectPathError("Project path escapes the Project root");
  }

  return resolved;
}
