export const CURRENT_FORMAT_VERSION = 1;

export class ProjectMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectMigrationError";
  }
}

export function migrateProjectData(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectMigrationError("Project data must be an object");
  }

  const manifest = (value as { manifest?: unknown }).manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ProjectMigrationError("Project manifest is missing");
  }

  const version = (manifest as { formatVersion?: unknown }).formatVersion;
  if (!Number.isInteger(version)) {
    throw new ProjectMigrationError("Project formatVersion is missing or invalid");
  }
  if ((version as number) > CURRENT_FORMAT_VERSION) {
    throw new ProjectMigrationError(`Project formatVersion ${String(version)} is newer than supported version 1`);
  }
  if ((version as number) < CURRENT_FORMAT_VERSION) {
    throw new ProjectMigrationError(`No migration is registered for Project formatVersion ${String(version)}`);
  }

  return structuredClone(value);
}
