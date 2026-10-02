import path from "node:path";
import os from "node:os";

export interface ServerConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  projectDirectory: string;
  clientDirectory: string;
  projectsDirectory?: string;
  stateDirectory?: string;
  sourceDirectory?: string;
  demoDirectory?: string;
}

export function defaultStateDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  homeDirectory = os.homedir()
): string {
  if (environment.OUTMAPPER_DATA_DIR) return path.resolve(environment.OUTMAPPER_DATA_DIR);
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA ?? path.join(homeDirectory, "AppData", "Local"), "Outmapper");
  }
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Application Support", "Outmapper");
  return path.join(environment.XDG_DATA_HOME ?? path.join(homeDirectory, ".local", "share"), "Outmapper");
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
  applicationDirectory = workingDirectory
): ServerConfig {
  const port = Number(environment.OUTMAPPER_PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("OUTMAPPER_PORT must be an integer between 0 and 65535");
  }

  const host = environment.OUTMAPPER_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("OUTMAPPER_HOST must be a loopback address");
  }

  const stateDirectory = defaultStateDirectory(environment);
  const projectsDirectory = path.join(stateDirectory, "Projects");
  return {
    host,
    port,
    projectDirectory: path.resolve(
      workingDirectory,
      environment.OUTMAPPER_PROJECT_DIR ?? path.join(projectsDirectory, "AI Landscape")
    ),
    stateDirectory,
    projectsDirectory,
    sourceDirectory: path.resolve(applicationDirectory),
    demoDirectory: path.resolve(applicationDirectory, "fixtures/projects/ai-landscape"),
    clientDirectory: path.resolve(applicationDirectory, "dist/client")
  };
}
