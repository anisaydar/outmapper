import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";

const port = 4322;
const origin = `http://127.0.0.1:${port}`;
const chromePath = findChromiumExecutable();
const timestamp = "2026-09-30T00:00:00.000Z";

function denseProject() {
  const topics = [{ id: "topic-center", title: "Dense Studio", createdAt: timestamp, updatedAt: timestamp }];
  for (let index = 0; index < 60; index += 1) topics.push({ id: `topic-${index}`, title: `Related ${index + 1}`, createdAt: timestamp, updatedAt: timestamp });
  const keyIssues = Array.from({ length: 24 }, (_, index) => ({ id: `issue-${index}`, topicId: "topic-center", title: `Key Issue ${index + 1}`, order: index, createdAt: timestamp, updatedAt: timestamp }));
  const relationships = Array.from({ length: 240 }, (_, index) => ({ id: `relationship-${index}`, sourceTopicId: "topic-center", keyIssueId: index < 120 ? "issue-0" : `issue-${1 + (index % 23)}`, targetTopicId: `topic-${index % 60}`, order: index < 120 ? index : Math.floor(index / 23), createdAt: timestamp, updatedAt: timestamp }));
  return { manifest: { format: "outmapper-project", formatVersion: 2, id: "studio-density-check", title: "Dense Studio", createdAt: timestamp, updatedAt: timestamp, revision: 0, homeTopicId: "topic-center" }, topics, keyIssues, relationships, projectLinks: [], knowledgeItems: [], associations: [], assets: [], collections: [], snapshots: [] };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Studio density check server did not start");
}

const server = spawn(process.execPath, ["dist/server/src/server/main.js"], { cwd: process.cwd(), env: { ...process.env, OUTMAPPER_PORT: String(port) }, stdio: "ignore" });
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1024, height: 800 } });
  const page = await context.newPage();
  let project = denseProject();
  let mutationCount = 0;
  await page.route("**/api/project", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(project) }));
  await page.route("**/api/key-issues/**", async (route) => {
    const request = route.request();
    const body = request.postDataJSON();
    if (request.method() === "PATCH") {
      const id = request.url().split("/").at(-1);
      project.keyIssues = project.keyIssues.map((issue) => issue.id === id ? { ...issue, ...body, updatedAt: timestamp } : issue);
    } else if (request.method() === "PUT") {
      const ids = body.ids;
      project.relationships = project.relationships.map((relationship) => relationship.keyIssueId === "issue-0" ? { ...relationship, order: ids.indexOf(relationship.id) } : relationship);
    }
    project.manifest.revision += 1;
    mutationCount += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ project, history: { canUndo: true, canRedo: false } }) });
  });
  const started = performance.now();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  await page.locator("[data-entity-id='issue-0']").focus();
  await page.locator("[data-entity-id='issue-0']").press("Enter");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const studioReadyMs = performance.now() - started;
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("Edited dense issue");
  await page.waitForTimeout(550);
  await page.getByRole("button", { name: /Move later: Related/ }).first().click();
  await page.waitForTimeout(50);
  const metrics = await page.evaluate(() => {
    const panel = document.querySelector(".knowledge-panel");
    return {
      scrollable: Boolean(panel && panel.scrollHeight > panel.clientHeight),
      panelScrollHeight: panel?.scrollHeight ?? 0,
      panelClientHeight: panel?.clientHeight ?? 0,
      relationshipRows: document.querySelectorAll(".studio-section .order-row").length,
      focusableControls: document.querySelectorAll(".studio-panel button:not(:disabled), .studio-panel input, .studio-panel textarea, .studio-panel select").length,
      title: document.querySelector(".studio-heading h1")?.textContent
    };
  });
  await page.setViewportSize({ width: 920, height: 800 });
  const panelVisibleAtTablet = await page.locator(".knowledge-panel").isVisible();
  const result = { studioReadyMs: Number(studioReadyMs.toFixed(1)), mutationCount, panelVisibleAtTablet, ...metrics };
  result.accepted = studioReadyMs < 2000 && mutationCount >= 2 && metrics.scrollable && metrics.relationshipRows === 120 && metrics.focusableControls >= 10 && metrics.title === "Edited dense issue" && panelVisibleAtTablet;
  console.log(JSON.stringify(result));
  if (!result.accepted) process.exitCode = 1;
  await context.close();
} finally {
  await browser?.close();
  server.kill();
}
