import { randomUUID } from "node:crypto";
import { access, cp, mkdir, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { DomainError } from "../domain/errors.js";
import { FileSystemProjectStore } from "../project/filesystem-project-store.js";
import type { ServerConfig } from "./config.js";

function safeProjectFolderName(title: string): string {
  return [...title.normalize("NFKC")]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || '<>:"/\\|?*'.includes(character) ? "_" : character;
    })
    .join("")
    .replace(/[. ]+$/u, "")
    .slice(0, 80) || "Project";
}

export function insideDirectory(root: string, directory: string): boolean {
  const relative = path.relative(root, directory);
  return relative === "" || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

export class ProjectLibrary {
  readonly projectsDirectory: string;

  constructor(private readonly config: ServerConfig) {
    this.projectsDirectory = config.projectsDirectory ?? path.dirname(config.projectDirectory);
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
    const name = safeProjectFolderName(title);
    const directory = path.join(this.projectsDirectory, `${name}-${randomUUID().slice(0, 8)}`);
    if (this.config.sourceDirectory && insideDirectory(this.config.sourceDirectory, directory)) throw new DomainError("invalid-command", "Working Projects must be outside the source checkout.");
    const now = new Date().toISOString();
    await new FileSystemProjectStore(directory).create({ manifest: { format: "outmapper-project", formatVersion: 2, id: randomUUID(), title: title.trim(), createdAt: now, updatedAt: now, revision: 0, defaultLocale: locale, defaultDirection: "auto" } });
    return directory;
  }

  async copyProject(sourceDirectory: string, title: string): Promise<string> {
    const directory = path.join(this.projectsDirectory, `${safeProjectFolderName(title)}-${randomUUID().slice(0, 8)}`);
    if (this.config.sourceDirectory && insideDirectory(this.config.sourceDirectory, directory)) throw new DomainError("invalid-command", "Working Projects must be outside the source checkout.");
    await mkdir(this.projectsDirectory, { recursive: true });
    await cp(sourceDirectory, directory, {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes(".outmapper")
    });
    const store = new FileSystemProjectStore(directory);
    const project = await store.open();
    project.manifest.id = randomUUID();
    project.manifest.revision += 1;
    project.manifest.updatedAt = new Date().toISOString();
    await store.save(project);
    return directory;
  }
}
