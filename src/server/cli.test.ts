import { createServer } from "node:net";
import { browserCommand, CLI_HELP, CliUsageError, formatCliError, formatHelp, formatReady, parseCliArguments, selectAvailablePort, startProgress, supportsCurrentNode, terminalStyle } from "./cli.js";

const ansi = "\u001b[";

describe("Outmapper CLI", () => {
  it("parses help, version, project, port, and browser options", () => {
    expect(parseCliArguments(["--project", "C:\\Projects\\Atlas", "--port=4310", "--no-open"])).toEqual({
      help: false,
      version: false,
      openBrowser: false,
      port: 4310,
      projectDirectory: "C:\\Projects\\Atlas"
    });
    expect(parseCliArguments(["--help"])).toMatchObject({ help: true });
    expect(parseCliArguments(["--version"])).toMatchObject({ version: true });
    expect(() => parseCliArguments(["--port", "70000"])).toThrow("--port must be an integer between 0 and 65535");
    expect(() => parseCliArguments(["--unknown"])).toThrow("Unknown option");
  });

  it("marks argument problems as usage errors with a help hint", () => {
    let caught: unknown;
    try { parseCliArguments(["--nope"]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CliUsageError);
    expect(formatCliError(caught)).toBe('outmapper: Unknown option: --nope\nRun "outmapper --help" to see the available options.');
    expect(formatCliError(new Error("Port 4173 became unavailable."))).toBe("outmapper: Port 4173 became unavailable.");
  });

  it("uses color only for terminals and respects NO_COLOR", () => {
    expect(terminalStyle({ isTTY: true }, {})).toEqual({ color: true, interactive: true });
    expect(terminalStyle({ isTTY: true }, { NO_COLOR: "1" })).toEqual({ color: false, interactive: true });
    expect(terminalStyle({ isTTY: false }, {})).toEqual({ color: false, interactive: false });
    expect(terminalStyle({ isTTY: true }, { TERM: "dumb" })).toEqual({ color: false, interactive: false });
    expect(terminalStyle({ isTTY: true }, { CI: "true" })).toMatchObject({ interactive: false });
    expect(terminalStyle({ isTTY: false }, { FORCE_COLOR: "1", NO_COLOR: "1" }).color).toBe(false);
    expect(CLI_HELP).not.toContain(ansi);
    expect(CLI_HELP).toContain("npx outmapper@latest");
    expect(CLI_HELP).toContain("--no-open");
    expect(CLI_HELP).toContain("NO_COLOR");
    expect(formatHelp({ color: true, interactive: true })).toContain(ansi);
  });

  it("prints a plain readiness summary for non-interactive output", () => {
    const ready = formatReady({ url: "http://127.0.0.1:4173", projectsDirectory: "/data/Projects", elapsedMs: 412.4, openBrowser: false });
    expect(ready).not.toContain(ansi);
    expect(ready).toContain("ready in 412 ms");
    expect(ready).toContain("Local:    http://127.0.0.1:4173");
    expect(ready).toContain("Projects: /data/Projects");
    expect(ready).not.toContain("Project:");
    expect(ready).toContain("Press Ctrl+C to stop.");
    expect(formatReady({ url: "u", elapsedMs: 1, openBrowser: true, projectDirectory: "/p" })).toContain("Opening your browser.");
  });

  it("does not write progress frames outside interactive terminals", async () => {
    const write = vi.fn(() => true);
    const progress = startProgress("Starting", { isTTY: false, write }, { color: false, interactive: false });
    await new Promise((resolve) => setTimeout(resolve, 250));
    progress.stop();
    expect(write).not.toHaveBeenCalled();

    const interactiveWrite = vi.fn(() => true);
    const interactive = startProgress("Starting", { isTTY: true, write: interactiveWrite }, { color: false, interactive: true });
    interactive.stop();
    expect(interactiveWrite).not.toHaveBeenCalled();
  });

  it("checks the documented minimum Node.js version", () => {
    expect(supportsCurrentNode("22.22.1")).toBe(false);
    expect(supportsCurrentNode("22.22.2")).toBe(true);
    expect(supportsCurrentNode("24.0.0")).toBe(true);
  });

  it("uses native browser launchers without a shell", () => {
    const url = "http://127.0.0.1:4173";
    expect(browserCommand(url, "win32")).toEqual({ command: "explorer.exe", arguments: [url] });
    expect(browserCommand(url, "darwin")).toEqual({ command: "open", arguments: [url] });
    expect(browserCommand(url, "linux")).toEqual({ command: "xdg-open", arguments: [url] });
  });

  it("does not take a configured busy port and finds a free fallback for the default", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen({ host: "127.0.0.1", port: 0 }, resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("Test port was not assigned");
    try {
      await expect(selectAvailablePort("127.0.0.1", address.port, false)).rejects.toMatchObject({ code: "EADDRINUSE" });
      const fallback = await selectAvailablePort("127.0.0.1", address.port, true);
      expect(fallback.usedFallback).toBe(true);
      expect(fallback.port).not.toBe(address.port);
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => error ? reject(error) : resolve()));
    }
  });
});
