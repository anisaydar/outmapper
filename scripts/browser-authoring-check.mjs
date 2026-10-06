import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";

const port = 4323;
const origin = `http://127.0.0.1:${port}`;
const chromePath = findChromiumExecutable();
const parent = await mkdtemp(path.join(os.tmpdir(), "outmapper-browser-"));
const projectDirectory = path.join(parent, "project");
await cp(path.resolve("fixtures/projects/ai-landscape"), projectDirectory, { recursive: true });
await rm(path.join(projectDirectory, ".outmapper"), { recursive: true, force: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Browser authoring check server did not start");
}

const server = spawn(process.execPath, ["dist/server/src/server/main.js"], {
  cwd: process.cwd(),
  env: { ...process.env, OUTMAPPER_PORT: String(port), OUTMAPPER_PROJECT_DIR: projectDirectory },
  stdio: "ignore"
});

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  assert((await page.getByText("NIST AI Risk Management Framework").count()) > 0, "Topic Knowledge did not render");
  const issue = page.locator("[data-entity-id='issue-research']");
  await issue.focus();
  await issue.press("Enter");
  assert((await page.getByText("Holistic Evaluation of Language Models (HELM)").count()) > 0, "Key Issue Knowledge did not synchronize");
  assert((await page.getByText("External").count()) > 0, "External availability was not explicit");
  await page.getByRole("button", { name: "Hide Panel" }).click();
  await page.getByRole("button", { name: "Show Panel" }).click();
  assert((await issue.getAttribute("aria-pressed")) === "true", "Panel toggle cleared selection");

  await page.locator("[data-map-node='central']").click();
  await page.locator("[data-entity-id='topic-science']").click();
  await page.locator(".map-world.is-topic-leaving .map-node.is-promoting").waitFor();
  const science = page.locator("[data-map-node='central'][data-entity-id='topic-science']");
  await science.waitFor();
  assert(await science.evaluate((element) => document.activeElement === element), "Topic navigation did not restore focus");
  await page.locator("[data-entity-id='topic-ai']").click();
  await page.locator("[data-map-node='central'][data-entity-id='topic-ai']").waitFor();
  await page.getByRole("button", { name: "Back" }).click();
  await science.waitFor();
  await page.getByRole("button", { name: "Home" }).click();
  await page.locator("[data-map-node='central'][data-entity-id='topic-ai']").waitFor();
  assert(!await page.getByRole("button", { name: "Back" }).isDisabled(), "Home did not preserve session history");

  await page.locator("[data-entity-id='issue-research']").focus();
  await page.locator("[data-entity-id='issue-research']").press("Enter");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("Research, Evaluation & Evidence");
  await page.waitForFunction(() => document.querySelector(".save-state")?.textContent?.includes("Autosaved"));
  assert((await title.inputValue()) === "Research, Evaluation & Evidence", "Studio autosave did not preserve the edit");
  await page.locator(".studio-heading").click();
  await page.keyboard.press("Control+z");
  await page.waitForFunction(() => document.querySelector("input")?.value === "Research & Evaluation");
  await page.keyboard.press("Control+Shift+z");
  await page.waitForFunction(() => document.querySelector("input")?.value === "Research, Evaluation & Evidence");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();

  const project = await (await fetch(`${origin}/api/project`)).json();
  const search = await (await fetch(`${origin}/api/search?q=evaluation`)).json();
  assert(project.keyIssues.find(({ id }) => id === "issue-research")?.title === "Research, Evaluation & Evidence", "Done did not persist the Studio edit");
  assert(search.total > 0, "Derived SQLite search did not reflect canonical content");

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Discard this title");
  await page.waitForFunction(() => document.querySelector(".save-state")?.textContent?.includes("Autosaved"));
  await page.getByRole("button", { name: "Cancel editing" }).click();
  const discard = page.getByRole("dialog", { name: "Discard changes?" });
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
  const revertedProject = await (await fetch(`${origin}/api/project`)).json();
  assert(revertedProject.keyIssues.find(({ id }) => id === "issue-research")?.title === "Research, Evaluation & Evidence", "Cancel did not revert the editing session");

  await context.close();

  const mobileContext = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const mobile = await mobileContext.newPage();
  await mobile.goto(origin, { waitUntil: "domcontentloaded" });
  await mobile.locator("[data-map-ready='true']").waitFor();
  const mobileIssue = mobile.locator("[data-entity-id='issue-research']");
  await mobileIssue.focus();
  await mobileIssue.press("Enter");
  await mobile.locator(".mobile-tabs button").nth(1).click();
  await mobile.getByRole("button", { name: "Edit", exact: true }).click();
  const combobox = mobile.getByRole("combobox", { name: "Add relationship" });
  await combobox.scrollIntoViewIfNeeded();
  await combobox.click();
  const listbox = mobile.getByRole("listbox", { name: "Add relationship" });
  await listbox.waitFor();
  const [listBounds, tabsBounds] = await Promise.all([listbox.boundingBox(), mobile.locator(".mobile-tabs").boundingBox()]);
  assert(listBounds && tabsBounds, "Mobile relationship dropdown geometry was unavailable");
  assert(listBounds.y + listBounds.height <= tabsBounds.y + 1, `Relationship dropdown is hidden behind the mobile tab bar: ${JSON.stringify({ listBounds, tabsBounds })}`);
  assert(await listbox.locator("[role='option']").last().isVisible(), "Relationship dropdown's lower rows are not visible at 360px");
  await mobile.keyboard.press("Escape");
  await mobile.getByRole("button", { name: "Done" }).click();
  await mobileContext.close();

  console.log(JSON.stringify({ knowledgeContext: "passed", panelSelection: "passed", cycleBackHome: "passed", focusRestoration: "passed", autosave: "passed", undoRedo: "passed", done: "passed", cancel: "passed", mobileCombobox360: "passed", sqliteSearch: "passed", searchHits: search.total }));
} finally {
  await browser?.close();
  server.kill();
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    server.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  await rm(parent, { recursive: true, force: true });
}
