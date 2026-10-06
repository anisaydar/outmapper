import path from "node:path";
import { defaultStateDirectory, loadServerConfig } from "./config.js";

describe("server configuration", () => {
  it("uses platform application-data locations for managed Projects", () => {
    const exampleHome = path.resolve("example-home");
    expect(defaultStateDirectory({}, "win32", exampleHome)).toBe(path.join(exampleHome, "AppData", "Local", "Outmapper"));
    expect(defaultStateDirectory({}, "darwin", exampleHome)).toBe(path.join(exampleHome, "Library", "Application Support", "Outmapper"));
    expect(defaultStateDirectory({}, "linux", exampleHome)).toBe(path.join(exampleHome, ".local", "share", "Outmapper"));
  });

  it("keeps caller-relative Project paths separate from packaged application assets", () => {
    const config = loadServerConfig(
      { OUTMAPPER_DATA_DIR: path.resolve("temporary-data"), OUTMAPPER_PROJECT_DIR: "research-project" },
      path.resolve("caller"),
      path.resolve("installed-package")
    );

    expect(config.projectDirectory).toBe(path.resolve("caller", "research-project"));
    expect(config.clientDirectory).toBe(path.resolve("installed-package", "dist/client"));
    expect(config.demoDirectory).toBe(path.resolve("installed-package", "fixtures/projects/ai-landscape"));
    expect(config.projectsDirectory).toBe(path.resolve("temporary-data", "Projects"));
  });
});
