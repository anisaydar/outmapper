import { cp, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";
import { loadServerConfig } from "../dist/server/src/server/config.js";
import { buildServer } from "../dist/server/src/server/server.js";

const port = 4325;
const origin = `http://127.0.0.1:${port}`;
const root = await mkdtemp(path.join(os.tmpdir(), "outmapper-workspace-browser-"));
const projectsDirectory = path.join(root, "Projects");
const stateDirectory = path.join(root, "state");
let selectedFolder = null;
let browser;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, url, body) {
  const response = await fetch(`${origin}${url}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${url} failed (${response.status}): ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function createProject(title, topicTitle, issueTitle) {
  const created = await request("POST", "/api/projects/new", { title, locale: "en" });
  const topicResult = await request("POST", "/api/topics", { title: topicTitle });
  const topic = topicResult.project.topics.find(({ title: value }) => value === topicTitle);
  const issueResult = await request("POST", "/api/key-issues", { topicId: topic.id, title: issueTitle });
  const issue = issueResult.project.keyIssues.find(({ title: value }) => value === issueTitle);
  const workspace = await request("GET", "/api/workspace/projects");
  return { id: issueResult.project.manifest.id, instanceId: created.instanceId, directory: workspace.projects[created.instanceId].directory, topic, issue };
}

async function openSettings(page) {
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  if (!await page.locator(".settings-popover").isVisible().catch(() => false)) await settings.click();
  await page.locator(".settings-popover").waitFor();
}

const server = await buildServer({
  ...loadServerConfig({}, process.cwd()),
  projectDirectory: path.resolve("fixtures/projects/ai-landscape"),
  projectsDirectory,
  stateDirectory,
  clientDirectory: path.resolve("dist/client"),
  port
}, { selectFolder: async () => selectedFolder });

try {
  await mkdir(projectsDirectory, { recursive: true });
  await server.listen({ host: "127.0.0.1", port });
  const projectA = await createProject("Project A", "Atlas A", "Bridge");
  const projectB = await createProject("Project B", "Atlas B", "Signals");
  await request("POST", `/api/workspace/projects/${projectA.instanceId}/activate`, {});

  browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true });
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();

  const issue = page.locator(`[data-entity-id='${projectA.issue.id}']`);
  await issue.focus();
  await issue.press("Enter");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Add relationship" }).click();
  await page.getByRole("option", { name: "Link another Project…", exact: true }).click();
  const linkDialog = page.getByRole("dialog", { name: "Link another Project…" });
  await linkDialog.getByLabel("Choose a Project").selectOption({ label: "Project B" });
  await linkDialog.getByLabel("Note (optional)").fill("Shared evidence path");
  await linkDialog.getByRole("button", { name: "Add", exact: true }).click();
  await linkDialog.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Done", exact: true }).click();

  const portalName = `Linked Project: Project B, Connected via Bridge`;
  const portal = page.getByRole("button", { name: portalName });
  await portal.click();
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".map-node--portal"));
  assert((await request("GET", "/api/project")).projectLinks.length === 0, "Undo after A → B → A did not restore Project A");

  await request("POST", "/api/project-links", {
    sourceTopicId: projectA.topic.id,
    keyIssueId: projectA.issue.id,
    targetProjectId: projectB.id,
    cachedProjectTitle: "Project B",
    note: "Shared evidence path"
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".map-node--portal").waitFor();

  const packageResponse = await fetch(`${origin}/api/packages/export`, { headers: { accept: "application/vnd.outmapper.package+zip" } });
  assert(packageResponse.ok, "Project A export failed");
  const packagePath = path.join(root, "project-a.outmapper");
  await writeFile(packagePath, Buffer.from(await packageResponse.arrayBuffer()));

  const movedB = path.join(root, "moved-project-b");
  await rename(projectB.directory, movedB);
  selectedFolder = movedB;
  const missingWorkspace = await request("POST", "/api/workspace/refresh", {});
  assert(missingWorkspace.projects[projectB.instanceId].status === "missing", "Moved Project B was not marked missing");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".map-node--portal.is-unavailable").waitFor();
  await page.getByRole("button", { name: portalName }).click();
  await page.getByText("Project unavailable", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Locate...", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();

  const duplicateB = path.join(root, "duplicate-project-b");
  await cp(movedB, duplicateB, { recursive: true });
  selectedFolder = duplicateB;
  await openSettings(page);
  await page.getByRole("button", { name: "Open Project...", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();
  await page.getByRole("button", { name: portalName }).click();
  await page.getByRole("button", { name: "Open Project", exact: true }).click();
  const chooser = page.getByRole("dialog", { name: "Choose a Project copy" });
  await chooser.getByLabel("Remember my choice").check();
  await chooser.locator(".duplicate-choice__main").first().click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();

  await openSettings(page);
  await page.getByRole("button", { name: "Import Project file…", exact: true }).click();
  await page.getByLabel("Import Project file…").setInputFiles(packagePath);
  const importDialog = page.getByRole("dialog", { name: "Project A" });
  const copyMode = importDialog.getByLabel("Import as a copy");
  await copyMode.waitFor();
  assert(await copyMode.isChecked(), "Import as a copy was not the default for a registered Project ID");
  await importDialog.getByRole("button", { name: "Import Project", exact: true }).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();
  assert((await request("GET", "/api/project")).manifest.id !== projectA.id, "Import as a copy retained the registered Project ID");
  await context.close();

  const responsiveCases = [
    { width: 360, height: 740, locale: "ar", colorScheme: "dark" },
    { width: 768, height: 820, locale: "en", colorScheme: "light" },
    { width: 1280, height: 820, locale: "ar", colorScheme: "dark" }
  ];
  for (const testCase of responsiveCases) {
    const responsiveContext = await browser.newContext({ viewport: { width: testCase.width, height: testCase.height }, colorScheme: testCase.colorScheme, reducedMotion: "reduce" });
    const responsivePage = await responsiveContext.newPage();
    responsivePage.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    responsivePage.on("pageerror", (error) => errors.push(error.message));
    await responsivePage.goto(origin, { waitUntil: "domcontentloaded" });
    await responsivePage.locator("[data-map-ready='true']").waitFor();
    if (testCase.locale === "ar") {
      await responsivePage.getByRole("button", { name: "Settings", exact: true }).click();
      await responsivePage.getByRole("button", { name: "Language: English", exact: true }).click();
      await responsivePage.getByRole("option", { name: "العربية", exact: true }).click();
      assert(await responsivePage.locator("html").getAttribute("dir") === "rtl", `Arabic RTL failed at ${testCase.width}px`);
    }
    const overflow = await responsivePage.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert(!overflow, `Horizontal overflow at ${testCase.width}px`);
    await responsiveContext.close();
  }

  assert(errors.length === 0, `Browser console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ portalNavigation: "passed", backUndo: "passed", moveAndLocate: "passed", duplicateChooser: "passed", importAsCopy: "passed", viewports: responsiveCases.map(({ width }) => width), locales: ["en", "ar"], themes: ["light", "dark"] }));
} finally {
  await browser?.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
