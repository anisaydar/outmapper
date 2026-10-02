#!/usr/bin/env node

const MINIMUM_NODE_MAJOR = 22;
const MINIMUM_NODE_MINOR = 22;
const MINIMUM_NODE_PATCH = 2;
const [nodeMajor = 0, nodeMinor = 0, nodePatch = 0] = process.versions.node.split(".").map(Number);
const supported = nodeMajor > MINIMUM_NODE_MAJOR || nodeMajor === MINIMUM_NODE_MAJOR && (
  nodeMinor > MINIMUM_NODE_MINOR || nodeMinor === MINIMUM_NODE_MINOR && nodePatch >= MINIMUM_NODE_PATCH
);

if (!supported) {
  console.error(`outmapper: Outmapper requires Node.js 22.22.2 or newer. Current version: ${process.versions.node}`);
  process.exitCode = 1;
} else {
  let cli: typeof import("./cli.js") | undefined;
  try {
    cli = await import("./cli.js");
    await cli.runCli();
  } catch (error) {
    console.error(cli ? cli.formatCliError(error, cli.terminalStyle(process.stderr)) : `outmapper: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
