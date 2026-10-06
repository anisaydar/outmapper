import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";

const port = 4321;
const origin = `http://127.0.0.1:${port}`;
const chromePath = findChromiumExecutable();
const timestamp = "2026-09-30T00:00:00.000Z";

function project() {
  const topics = ["A", "B", "C", "D", "E", "F"].map((title) => ({
    id: `topic-${title.toLowerCase()}`,
    title: `Topic ${title}`,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  const keyIssues = [
    { id: "issue-a", topicId: "topic-a", title: "A context", order: 0, createdAt: timestamp, updatedAt: timestamp },
    { id: "issue-b", topicId: "topic-b", title: "B context", order: 0, createdAt: timestamp, updatedAt: timestamp },
    { id: "issue-d1", topicId: "topic-d", title: "D first", order: 0, createdAt: timestamp, updatedAt: timestamp },
    { id: "issue-d2", topicId: "topic-d", title: "D second", order: 1, createdAt: timestamp, updatedAt: timestamp }
  ];
  const links = [
    ["ab", "topic-a", "issue-a", "topic-b"], ["ac", "topic-a", "issue-a", "topic-c"],
    ["ad", "topic-a", "issue-a", "topic-d"], ["ba", "topic-b", "issue-b", "topic-a"],
    ["bc", "topic-b", "issue-b", "topic-c"], ["de", "topic-d", "issue-d1", "topic-e"],
    ["df", "topic-d", "issue-d2", "topic-f"]
  ];
  return {
    manifest: { format: "outmapper-project", formatVersion: 2, id: "topic-navigation-check", title: "Topic Navigation Check", createdAt: timestamp, updatedAt: timestamp, revision: 0, homeTopicId: "topic-a" },
    topics,
    keyIssues,
    relationships: links.map(([id, sourceTopicId, keyIssueId, targetTopicId], order) => ({ id: `relationship-${id}`, sourceTopicId, keyIssueId, targetTopicId, order, createdAt: timestamp, updatedAt: timestamp })),
    projectLinks: [], knowledgeItems: [], associations: [], assets: [], collections: [], snapshots: []
  };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Topic navigation check server did not start");
}

async function openTopic(page, id) {
  const started = await page.evaluate(() => performance.now());
  await page.locator(`[data-map-node='topic'][data-entity-id='${id}']`).click();
  const center = page.locator(`[data-map-node='central'][data-entity-id='${id}']`);
  await center.waitFor();
  const elapsed = (await page.evaluate(() => performance.now())) - started;
  return { elapsed, focused: await center.evaluate((element) => document.activeElement === element) };
}

const server = spawn(process.execPath, ["dist/server/src/server/main.js"], {
  cwd: process.cwd(),
  env: { ...process.env, OUTMAPPER_PORT: String(port) },
  stdio: "ignore"
});

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await page.route("**/api/project", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(project()) }));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();

  const shared = await openTopic(page, "topic-b");
  const sharedCount = Number(await page.locator(".map-world").getAttribute("data-shared-topic-count"));
  const cycle = await openTopic(page, "topic-a");
  const different = await openTopic(page, "topic-d");
  const differentSharedCount = Number(await page.locator(".map-world").getAttribute("data-shared-topic-count"));
  const changedRingCount = await page.locator("[data-map-node='issue']").count();
  await page.getByRole("button", { name: "Back" }).click();
  await page.locator("[data-map-node='central'][data-entity-id='topic-a']").waitFor();
  const reversed = await page.locator("[data-map-node='central'][data-entity-id='topic-a']").evaluate((element) => document.activeElement === element);
  await context.close();

  const reducedContext = await browser.newContext({ viewport: { width: 1280, height: 820 }, reducedMotion: "reduce" });
  const reducedPage = await reducedContext.newPage();
  await reducedPage.route("**/api/project", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(project()) }));
  await reducedPage.goto(origin, { waitUntil: "domcontentloaded" });
  await reducedPage.locator("[data-map-ready='true']").waitFor();
  const reduced = await openTopic(reducedPage, "topic-d");
  const reducedMotion = await reducedPage.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const animationDuration = await reducedPage.locator(".map-world").evaluate((element) => getComputedStyle(element).animationDuration);
  await reducedContext.close();

  const result = {
    sharedMs: Number(shared.elapsed.toFixed(1)), sharedCount, sharedFocus: shared.focused,
    cycleMs: Number(cycle.elapsed.toFixed(1)), cycleFocus: cycle.focused,
    differentMs: Number(different.elapsed.toFixed(1)), differentSharedCount, changedRingCount,
    reversedFocus: reversed, reducedMs: Number(reduced.elapsed.toFixed(1)), reducedFocus: reduced.focused,
    reducedMotion, animationDuration
  };
  result.accepted = sharedCount === 1 && differentSharedCount === 0 && changedRingCount === 2 && shared.focused && cycle.focused && reduced.focused && reversed && reducedMotion && Math.max(shared.elapsed, cycle.elapsed, different.elapsed, reduced.elapsed) < 1500;
  console.log(JSON.stringify(result));
  if (!result.accepted) process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
