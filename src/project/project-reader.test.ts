import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileSystemProjectStore } from "./filesystem-project-store.js";
import { ProjectReader } from "./project-reader.js";
import { createValidProject } from "../test/project-fixtures.js";

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) await visit(absolute);
      else result[relative] = (await readFile(absolute)).toString("base64");
    }
  };
  await visit(root);
  return result;
}

describe("ProjectReader", () => {
  it("migrates v1 in memory and writes nothing to the Project directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-reader-"));
    try {
      const project = createValidProject();
      await new FileSystemProjectStore(directory).create(project);
      await rm(path.join(directory, "data", "project-links"), { recursive: true, force: true });
      const manifestPath = path.join(directory, "project.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.formatVersion = 1;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rm(path.join(directory, ".outmapper"), { recursive: true, force: true });
      const before = await snapshotTree(directory);

      const read = await new ProjectReader().read(directory, project.manifest.id);

      expect(read.status).toBe("available");
      expect(read.project?.manifest.formatVersion).toBe(2);
      expect(read.project?.projectLinks).toEqual([]);
      expect(await snapshotTree(directory)).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reports a pending canonical recovery without recovering it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "outmapper-reader-pending-"));
    try {
      const project = createValidProject();
      await new FileSystemProjectStore(directory).create(project);
      const marker = path.join(directory, ".outmapper", "runtime", "canonical-recovery.json");
      await mkdir(path.dirname(marker), { recursive: true });
      await writeFile(marker, JSON.stringify(project), "utf8");
      expect((await new ProjectReader().read(directory)).status).toBe("needs-open");
      expect(await readFile(marker, "utf8")).toBe(JSON.stringify(project));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
