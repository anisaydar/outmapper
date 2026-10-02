import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versionSource = await readFile(new URL("../src/version.ts", import.meta.url), "utf8");
const expectedVersion = versionSource.match(/APPLICATION_VERSION = "([^"]+)"/)?.[1];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(packageManifest.name === "outmapper", "Package name must remain outmapper");
assert(packageManifest.version === expectedVersion, "package.json and application version are out of sync");
assert(packageManifest.bin?.outmapper === "dist/server/src/server/cli-entry.js", "Package bin must point to the guarded prebuilt CLI entry");
assert(Array.isArray(packageManifest.files) && packageManifest.files.length > 0, "Package requires an explicit files allowlist");

const npmCli = process.env.npm_execpath;
assert(npmCli, "npm_execpath is required to inspect the package");
const packed = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--ignore-scripts", "--json"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8"
});
if (packed.status !== 0) throw new Error(packed.stderr || packed.error?.message || "npm pack --dry-run failed");
const packResult = JSON.parse(packed.stdout);
const report = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
const files = report.files.map(({ path }) => path.replaceAll("\\", "/"));
const allowedRootFiles = new Set(["CHANGELOG.md", "LICENSE", "NOTICE", "README.md", "THIRD_PARTY_NOTICES.md", "package.json"]);
const allowed = (file) => allowedRootFiles.has(file) || file.startsWith("dist/") || file.startsWith("fixtures/projects/ai-landscape/");
const unexpected = files.filter((file) => !allowed(file));

assert(unexpected.length === 0, `Unexpected release files: ${unexpected.join(", ")}`);
const forbidden = files.filter((file) => file.includes("/.outmapper/") || file.includes("/src/test/") || /\.test\.[^.]+(?:\.map)?$/.test(file));
assert(forbidden.length === 0, `Private, derived, or test files entered the package: ${forbidden.join(", ")}`);
for (const required of [
  "NOTICE",
  "dist/client/index.html",
  "dist/client/brand/outmapper-mark-dark.svg",
  "dist/client/brand/outmapper-mark-light.svg",
  "dist/server/src/server/cli-entry.js",
  "fixtures/projects/ai-landscape/project.json"
]) {
  assert(files.includes(required), `Release package is missing ${required}`);
}

const cli = spawnSync(process.execPath, ["dist/server/src/server/cli-entry.js", "--version"], { encoding: "utf8" });
assert(cli.status === 0 && cli.stdout.trim() === packageManifest.version, "Prebuilt CLI --version did not match package.json");
const help = spawnSync(process.execPath, ["dist/server/src/server/cli-entry.js", "--help"], { encoding: "utf8" });
assert(help.status === 0 && help.stdout.includes("npx outmapper@latest") && help.stdout.includes("--no-open"), "Prebuilt CLI help is incomplete");

console.log(JSON.stringify({ name: report.name, version: report.version, files: files.length, unpackedBytes: report.unpackedSize }));
