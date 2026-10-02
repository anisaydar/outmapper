import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { cp, mkdtemp, readFile, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";

const port = 4325;
const origin = `http://127.0.0.1:${port}`;
const chromePath = findChromiumExecutable();
const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-release-check-"));
const projectDirectory = path.join(parent, "project");
await cp(path.resolve("fixtures/projects/ai-landscape"), projectDirectory, { recursive: true });
await rm(path.join(projectDirectory, ".outmapper"), { recursive: true, force: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Offline release check server did not start");
}

async function startServer() {
  const child = spawn(process.execPath, ["dist/server/src/server/main.js"], {
    cwd: process.cwd(),
    env: { ...process.env, OUTMAPPER_PORT: String(port), OUTMAPPER_PROJECT_DIR: projectDirectory },
    stdio: "ignore"
  });
  await waitForServer();
  return child;
}

async function stopServer(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGTERM");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(child.exitCode);
    }, 5_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

let server;
let browser;
try {
  server = await startServer();
  const opened = await (await fetch(`${origin}/api/project`)).json();
  assert(opened.manifest.id === "project-ai-landscape", "Configured filesystem Project did not open");
  const runtimePath = path.join(projectDirectory, ".outmapper", "runtime.sqlite");
  assert((await stat(runtimePath)).isFile(), "Derived SQLite runtime was not created");
  await stopServer(server);
  server = undefined;

  await unlink(runtimePath);
  server = await startServer();
  const rebuiltSearch = await (await fetch(`${origin}/api/search?q=governing`)).json();
  assert(rebuiltSearch.total > 0, "Search did not recover after runtime database deletion");
  assert((await stat(runtimePath)).isFile(), "Derived SQLite runtime was not rebuilt");

  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const unexpectedExternal = [];
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || url.protocol === "data:" || url.protocol === "blob:") return route.continue();
    unexpectedExternal.push(url.href);
    return route.abort("internetdisconnected");
  });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  assert(unexpectedExternal.length === 0, `Application attempted external requests: ${unexpectedExternal.join(", ")}`);
  const offlineBoundary = await page.evaluate(async (localOrigin) => {
    const local = await fetch(`${localOrigin}/api/health`).then((response) => response.ok).catch(() => false);
    const external = await fetch("https://example.org/outmapper-offline-check").then(() => true).catch(() => false);
    return { local, external };
  }, origin);
  assert(offlineBoundary.local && !offlineBoundary.external, "External-network-disabled localhost boundary failed");

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill("governing");
  await page.waitForFunction(() => document.querySelectorAll(".search-result").length > 0);
  await page.getByRole("button", { name: "Close search" }).click();
  await page.locator("[data-entity-id='issue-trust']").click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const editResponse = page.waitForResponse((response) => response.url().includes("/api/key-issues/") && response.request().method() === "PATCH");
  await page.getByLabel("Title", { exact: true }).fill("Governance and accountability");
  assert((await editResponse).ok(), "Studio autosave request failed");
  const attachment = page.getByLabel("Attach file");
  const uploadResponse = page.waitForResponse((response) => response.url().endsWith("/api/assets") && response.request().method() === "POST");
  await attachment.setInputFiles({ name: "offline-evidence.txt", mimeType: "text/plain", buffer: Buffer.from("Local-only acceptance evidence") });
  assert((await uploadResponse).status() === 201, "Managed Asset upload failed");
  await page.getByRole("button", { name: "Preview" }).click();
  const attachmentRow = page.getByRole("button", { name: /offline-evidence\.txt/ });
  await attachmentRow.click();
  assert(await page.getByRole("link", { name: /offline-evidence\.txt.*Open file/ }).isVisible(), "Attached Project file was not openable");

  const exported = await fetch(`${origin}/api/packages/export`);
  assert(exported.ok, "Project backup export failed");
  const archive = Buffer.from(await exported.arrayBuffer());
  const preview = await fetch(`${origin}/api/packages/import/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.outmapper.package+zip", "X-Outmapper-Filename": "release-check.outmapper" },
    body: archive
  });
  assert(preview.ok, "Exported Project did not pass staged reimport validation");
  const plan = await preview.json();
  const committed = await fetch(`${origin}/api/packages/import/${plan.id}/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directoryName: "reimported-release-check" })
  });
  assert(committed.ok, "Validated Project reimport did not commit");
  const importedDirectory = (await committed.json()).projectDirectory;
  const importedManifest = JSON.parse(await readFile(path.join(importedDirectory, "project.json"), "utf8"));
  assert(importedManifest.id === opened.manifest.id, "Reimport changed Project identity");
  const importedAssets = JSON.parse(await readFile(path.join(importedDirectory, "data", "assets", "records.json"), "utf8"));
  const importedAsset = importedAssets.find(({ originalFilename }) => originalFilename === "offline-evidence.txt");
  assert(importedAsset, "Reimport lost managed Asset metadata");
  assert((await readFile(path.join(importedDirectory, ...importedAsset.path.split("/")), "utf8")) === "Local-only acceptance evidence", "Reimport lost managed Asset bytes");

  const result = {
    startupReopen: "passed",
    sqliteDeleteRebuild: "passed",
    externalNetworkBlockedLocalhostAvailable: "passed",
    viewerSearchStudioPreview: "passed",
    managedAsset: "passed",
    backupExportReimport: "passed",
    unexpectedExternalRequests: 0,
    accepted: true
  };
  console.log(JSON.stringify(result));
  await context.close();
} finally {
  await browser?.close();
  if (server) await stopServer(server);
  await rm(parent, { recursive: true, force: true });
}
