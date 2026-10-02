import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APPLICATION_VERSION } from "../version.js";
import { loadServerConfig, type ServerConfig } from "./config.js";
import { buildServer } from "./server.js";

const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 22;
const MINIMUM_NODE_PATCH = 2;

export interface CliOptions {
  help: boolean;
  version: boolean;
  openBrowser: boolean;
  port?: number;
  projectDirectory?: string;
}

export class CliUsageError extends Error {}

export interface TerminalStyle {
  color: boolean;
  interactive: boolean;
}

interface OutputStream {
  isTTY?: boolean;
  write(chunk: string): boolean;
}

export function terminalStyle(stream: { isTTY?: boolean }, environment: NodeJS.ProcessEnv = process.env): TerminalStyle {
  const terminal = Boolean(stream.isTTY) && environment.TERM !== "dumb";
  const forced = environment.FORCE_COLOR !== undefined && environment.FORCE_COLOR !== "0" && environment.FORCE_COLOR !== "false";
  return {
    color: !environment.NO_COLOR && (forced || terminal),
    interactive: terminal && !environment.CI
  };
}

function painter(style: TerminalStyle) {
  const paint = (open: number, close: number) => (value: string) => style.color ? `\u001b[${open}m${value}\u001b[${close}m` : value;
  return { bold: paint(1, 22), dim: paint(2, 22), red: paint(31, 39), green: paint(32, 39), yellow: paint(33, 39), cyan: paint(36, 39) };
}

export function formatHelp(style: TerminalStyle = { color: false, interactive: false }): string {
  const { bold, dim } = painter(style);
  return `${bold("Outmapper")} ${APPLICATION_VERSION}
${dim("A local-first workspace for building and exploring interconnected knowledge maps.")}

${bold("Usage")}
  outmapper [options]
  npx outmapper@latest [options]

${bold("Options")}
  -h, --help             Show this help and exit
  -v, --version          Print the application version and exit
  --port <number>        Bind a specific loopback port (0 chooses a free port)
  --project <directory>  Open an existing Outmapper Project directory
  --no-open              Start without opening the default browser

${bold("Environment")}
  OUTMAPPER_DATA_DIR     Override the application data directory
  OUTMAPPER_PROJECT_DIR  Open an existing Project directory
  OUTMAPPER_PORT         Bind a specific loopback port
  OUTMAPPER_HOST         Set 127.0.0.1 or ::1 (loopback only)
  NO_COLOR               Disable colored output

${bold("Examples")}
  outmapper --no-open
  outmapper --project ./Research --port 4310`;
}

export const CLI_HELP = formatHelp();

export function formatReady(
  details: { url: string; projectsDirectory?: string; projectDirectory?: string; elapsedMs: number; openBrowser: boolean },
  style: TerminalStyle = { color: false, interactive: false }
): string {
  const { bold, dim, green, cyan } = painter(style);
  const rows: Array<[string, string]> = [["Local", cyan(details.url)]];
  if (details.projectDirectory) rows.push(["Project", details.projectDirectory]);
  if (details.projectsDirectory) rows.push(["Projects", details.projectsDirectory]);
  return [
    "",
    `  ${green(bold("Outmapper"))} ${APPLICATION_VERSION}  ${dim(`ready in ${Math.max(0, Math.round(details.elapsedMs))} ms`)}`,
    "",
    ...rows.map(([label, value]) => `  ${dim(`${label}:`.padEnd(10))}${value}`),
    "",
    `  ${dim(details.openBrowser ? "Opening your browser. Press Ctrl+C to stop." : "Press Ctrl+C to stop.")}`,
    ""
  ].join("\n");
}

export function formatCliError(error: unknown, style: TerminalStyle = { color: false, interactive: false }): string {
  const { red, bold, dim } = painter(style);
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof CliUsageError ? `\n${dim("Run \"outmapper --help\" to see the available options.")}` : "";
  return `${red(bold("outmapper:"))} ${message}${hint}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function startProgress(message: string, stream: OutputStream = process.stderr, style: TerminalStyle = terminalStyle(stream)) {
  if (!style.interactive) return { stop: () => undefined };
  const { cyan } = painter(style);
  let frame = 0;
  let visible = false;
  const render = () => {
    visible = true;
    stream.write(`\r\u001b[2K${cyan(SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length])} ${message}`);
  };
  const delay = setTimeout(render, 120);
  const interval = setInterval(() => { if (visible) render(); }, 80);
  delay.unref();
  interval.unref();
  return {
    stop: () => {
      clearTimeout(delay);
      clearInterval(interval);
      if (visible) stream.write("\r\u001b[2K");
    }
  };
}

function optionValue(argument: string, name: string): string | undefined {
  const prefix = `${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : undefined;
}

export function parseCliArguments(arguments_: string[]): CliOptions {
  const options: CliOptions = { help: false, version: false, openBrowser: true };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "-h" || argument === "--help") options.help = true;
    else if (argument === "-v" || argument === "--version") options.version = true;
    else if (argument === "--no-open") options.openBrowser = false;
    else if (argument === "--port" || optionValue(argument, "--port") !== undefined) {
      const value = optionValue(argument, "--port") ?? arguments_[++index];
      if (value === undefined) throw new CliUsageError("--port requires a value");
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new CliUsageError("--port must be an integer between 0 and 65535");
      }
      options.port = port;
    } else if (argument === "--project" || optionValue(argument, "--project") !== undefined) {
      const value = optionValue(argument, "--project") ?? arguments_[++index];
      if (!value) throw new CliUsageError("--project requires a directory");
      options.projectDirectory = value;
    } else {
      throw new CliUsageError(`Unknown option: ${argument}`);
    }
  }
  return options;
}

export function supportsCurrentNode(version = process.versions.node): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
  return major > MINIMUM_NODE_MAJOR || major === MINIMUM_NODE_MAJOR && (
    minor > MINIMUM_NODE_MINOR || minor === MINIMUM_NODE_MINOR && patch >= MINIMUM_NODE_PATCH
  );
}

async function probePort(host: ServerConfig["host"], port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host, port, exclusive: true }, () => {
      const address = probe.address();
      const selected = typeof address === "object" && address ? address.port : port;
      probe.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

export async function selectAvailablePort(
  host: ServerConfig["host"],
  requestedPort: number,
  allowFallback: boolean
): Promise<{ port: number; usedFallback: boolean }> {
  try {
    return { port: await probePort(host, requestedPort), usedFallback: false };
  } catch (error) {
    if (!allowFallback || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    return { port: await probePort(host, 0), usedFallback: true };
  }
}

export function browserCommand(url: string, platform = process.platform): { command: string; arguments: string[] } {
  if (platform === "win32") return { command: "explorer.exe", arguments: [url] };
  if (platform === "darwin") return { command: "open", arguments: [url] };
  return { command: "xdg-open", arguments: [url] };
}

function openBrowser(url: string): void {
  const launcher = browserCommand(url);
  const child = spawn(launcher.command, launcher.arguments, {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.once("error", () => undefined);
  child.unref();
}

function applicationRoot(): string {
  return path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
}

export async function runCli(arguments_ = process.argv.slice(2)): Promise<void> {
  const options = parseCliArguments(arguments_);
  if (options.help) {
    console.log(formatHelp(terminalStyle(process.stdout)));
    return;
  }
  if (options.version) {
    console.log(APPLICATION_VERSION);
    return;
  }
  if (!supportsCurrentNode()) {
    throw new Error(`Outmapper requires Node.js 22.22.2 or newer. Current version: ${process.versions.node}`);
  }

  const startedAt = performance.now();
  const environment = { ...process.env };
  if (options.port !== undefined) environment.OUTMAPPER_PORT = String(options.port);
  if (options.projectDirectory) environment.OUTMAPPER_PROJECT_DIR = options.projectDirectory;
  const configuredPort = options.port !== undefined || process.env.OUTMAPPER_PORT !== undefined;
  const config = loadServerConfig(environment, process.cwd(), applicationRoot());
  const requestedPort = config.port;
  const progress = startProgress(`Starting Outmapper ${APPLICATION_VERSION}…`);
  let server: Awaited<ReturnType<typeof buildServer>>;
  let selection: Awaited<ReturnType<typeof selectAvailablePort>>;
  try {
    selection = await selectAvailablePort(config.host, config.port, !configuredPort && config.port !== 0);
    config.port = selection.port;
    server = await buildServer(config);
    try {
      await server.listen({ host: config.host, port: config.port });
    } catch (error) {
      await server.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        throw new Error(`Port ${config.port} became unavailable. Choose another port with --port.`, { cause: error });
      }
      throw error;
    }
  } finally {
    progress.stop();
  }

  const hostForUrl = config.host === "::1" ? "[::1]" : config.host;
  const url = `http://${hostForUrl}:${config.port}`;
  const errorStyle = terminalStyle(process.stderr);
  if (selection.usedFallback) console.warn(painter(errorStyle).yellow(`Port ${requestedPort} is busy; using ${config.port} instead.`));
  console.log(formatReady({
    url,
    projectDirectory: options.projectDirectory || process.env.OUTMAPPER_PROJECT_DIR ? config.projectDirectory : undefined,
    projectsDirectory: config.projectsDirectory,
    elapsedMs: performance.now() - startedAt,
    openBrowser: options.openBrowser
  }, terminalStyle(process.stdout)));
  if (options.openBrowser) openBrowser(url);

  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const cleanup = () => {
      for (const signal of signals) process.removeListener(signal, shutdown);
    };
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      const shutdownProgress = startProgress("Stopping Outmapper…");
      void server.close().then(() => {
        shutdownProgress.stop();
        cleanup();
        console.log("Outmapper stopped.");
        resolve();
      }, (error) => {
        shutdownProgress.stop();
        cleanup();
        reject(error);
      });
    };
    for (const signal of signals) process.once(signal, shutdown);
  });
}
