import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import { FileSystemProjectStore } from "../project/filesystem-project-store.js";
import type { ServerConfig } from "./config.js";

export interface RecentProject { directory: string; title: string; id: string }

export function insideDirectory(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export class ProjectLibrary {
  readonly projectsDirectory: string;
  private readonly recentFile: string;

  constructor(private readonly config: ServerConfig) {
    this.projectsDirectory = config.projectsDirectory ?? path.dirname(config.projectDirectory);
    this.recentFile = path.join(config.stateDirectory ?? this.projectsDirectory, "recent-projects.json");
  }

  async prepare(): Promise<string> {
    let directory = this.config.projectDirectory;
    if (this.config.sourceDirectory && insideDirectory(this.config.sourceDirectory, directory)) {
      if (path.resolve(directory) !== this.config.demoDirectory) throw new DomainError("invalid-command", "Working Projects must be outside the source checkout.");
      directory = path.join(this.projectsDirectory, "AI Landscape");
    }
    if (this.config.demoDirectory && path.resolve(directory) === path.join(this.projectsDirectory, "AI Landscape")) {
      try { await access(path.join(directory, "project.json")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(this.projectsDirectory, { recursive: true });
        const staging = path.join(this.projectsDirectory, `.demo-${randomUUID()}`);
        try {
          await cp(this.config.demoDirectory, staging, { recursive: true, filter: (source) => !source.split(path.sep).includes(".outmapper") });
          await rename(staging, directory);
        } finally { await rm(staging, { recursive: true, force: true }); }
      }
    }
    return directory;
  }

  async recent(): Promise<RecentProject[]> {
    try {
      const records: unknown = JSON.parse(await readFile(this.recentFile, "utf8"));
      return Array.isArray(records) ? records.filter((record): record is RecentProject => record && typeof record.directory === "string" && typeof record.title === "string" && typeof record.id === "string").slice(0, 12) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return [];
      throw error;
    }
  }

  async remember(directory: string): Promise<void> {
    const project = await new FileSystemProjectStore(directory).open();
    const recent = await this.recent();
    const entries = [{ directory, title: project.manifest.title, id: project.manifest.id }, ...recent.filter((entry) => path.resolve(entry.directory).toLowerCase() !== path.resolve(directory).toLowerCase())].slice(0, 12);
    await mkdir(path.dirname(this.recentFile), { recursive: true });
    const temporary = `${this.recentFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(entries, null, 2), "utf8");
    await rename(temporary, this.recentFile);
  }

  async validateDirectory(directory: string): Promise<string> {
    const resolved = await realpath(directory);
    if (this.config.sourceDirectory && insideDirectory(await realpath(this.config.sourceDirectory), resolved)) {
      throw new DomainError("invalid-command", "Working Projects must be outside the source checkout.");
    }
    await access(resolved, constants.W_OK);
    await new FileSystemProjectStore(resolved).open();
    return resolved;
  }

  async create(title: string, locale: string): Promise<string> {
    if (!title.trim()) throw new DomainError("invalid-command", "Project title is required");
    const name = [...title.normalize("NFKC")]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || '<>:"/\\|?*'.includes(character) ? "_" : character;
      })
      .join("")
      .replace(/[. ]+$/u, "")
      .slice(0, 80) || "Project";
    const directory = path.join(this.projectsDirectory, `${name}-${randomUUID().slice(0, 8)}`);
    if (this.config.sourceDirectory && insideDirectory(this.config.sourceDirectory, directory)) throw new DomainError("invalid-command", "Working Projects must be outside the source checkout.");
    const now = new Date().toISOString();
    await new FileSystemProjectStore(directory).create({ manifest: { format: "outmapper-project", formatVersion: 1, id: randomUUID(), title: title.trim(), createdAt: now, updatedAt: now, revision: 0, defaultLocale: locale, defaultDirection: "auto" } });
    return directory;
  }
}
