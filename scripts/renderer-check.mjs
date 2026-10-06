import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";

const port = 4317;
const origin = `http://127.0.0.1:${port}`;
const chromePath = findChromiumExecutable();

function timestamp(index) {
  return `2026-09-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
}

function createProject(totalNodes) {
  const issueCount = totalNodes <= 25 ? 6 : totalNodes <= 50 ? 8 : 10;
  const relatedCount = totalNodes - issueCount - 1;
  const topics = [
    {
      id: "topic-center",
      title: "Artificial Intelligence",
      description: "A representative renderer projection.",
      createdAt: timestamp(0),
      updatedAt: timestamp(0)
    }
  ];
  const titles = [
    "Long-term institutional capacity and technical coordination",
    "التضليل المعلوماتي والهوية الرقمية",
    "Интерпретируемость сложных моделей",
    "Open source infrastructure",
    "Climate indicators and data centers"
  ];
  for (let index = 0; index < relatedCount; index += 1) {
    topics.push({
      id: `topic-${String(index).padStart(3, "0")}`,
      title: `${titles[index % titles.length]} ${index + 1}`,
      createdAt: timestamp(index + 1),
      updatedAt: timestamp(index + 1)
    });
  }
  const keyIssues = Array.from({ length: issueCount }, (_, index) => ({
    id: `issue-${index}`,
    topicId: "topic-center",
    title: `${titles[(index + 2) % titles.length]} — Key Issue ${index + 1}`,
    order: index,
    createdAt: timestamp(index),
    updatedAt: timestamp(index)
  }));
  const relationships = [];
  for (let index = 0; index < relatedCount; index += 1) {
    const primaryIssue = index % issueCount;
    relationships.push({
      id: `relationship-${index}-primary`,
      sourceTopicId: "topic-center",
      keyIssueId: `issue-${primaryIssue}`,
      targetTopicId: `topic-${String(index).padStart(3, "0")}`,
      order: index,
      createdAt: timestamp(index),
      updatedAt: timestamp(index)
    });
    relationships.push({
      id: `relationship-${index}-shared`,
      sourceTopicId: "topic-center",
      keyIssueId: `issue-${(primaryIssue + 2) % issueCount}`,
      targetTopicId: `topic-${String(index).padStart(3, "0")}`,
      order: index,
      createdAt: timestamp(index),
      updatedAt: timestamp(index)
    });
    if (index % 3 === 0) {
      relationships.push({
        id: `relationship-${index}-tertiary`,
        sourceTopicId: "topic-center",
        keyIssueId: `issue-${(primaryIssue + 4) % issueCount}`,
        targetTopicId: `topic-${String(index).padStart(3, "0")}`,
        order: index,
        createdAt: timestamp(index),
        updatedAt: timestamp(index)
      });
    }
  }
  return {
    manifest: {
      format: "outmapper-project",
      formatVersion: 2,
      id: `renderer-${totalNodes}`,
      title: `Renderer ${totalNodes}`,
      createdAt: timestamp(0),
      updatedAt: timestamp(0),
      revision: 1,
      homeTopicId: "topic-center"
    },
    topics,
    keyIssues,
    relationships,
    projectLinks: [],
    knowledgeItems: [],
    associations: [],
    assets: [],
    collections: [],
    snapshots: []
  };
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Renderer check server did not start");
}

async function measure(browser, totalNodes) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme: "dark" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__outmapperLongTasks = [];
    if (typeof PerformanceObserver !== "undefined") {
      const observer = new PerformanceObserver((list) => {
        window.__outmapperLongTasks.push(...list.getEntries().map(({ duration }) => duration));
      });
      try {
        observer.observe({ type: "longtask", buffered: true });
      } catch {
        observer.disconnect();
      }
    }
  });
  await page.route("**/api/project", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(createProject(totalNodes)) })
  );
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  const readyMs = await page.evaluate(() => performance.now());
  const issue = page.locator("[data-map-node='issue']").first();
  await issue.focus();
  const keyboardStart = await page.evaluate(() => performance.now());
  await issue.press("Enter");
  await page.waitForFunction(() => document.querySelector("[data-map-node='issue']")?.getAttribute("aria-pressed") === "true");
  const keyboardMs = (await page.evaluate(() => performance.now())) - keyboardStart;
  const metrics = await page.evaluate(async () => {
    const nodes = [...document.querySelectorAll("[data-map-node]")];
    const edges = [...document.querySelectorAll("[data-edge-id]")];
    const layoutStart = performance.now();
    const boxes = nodes.map((node) => node.getBoundingClientRect());
    const forcedLayoutMs = performance.now() - layoutStart;
    const multilingualLabels = nodes.filter((node) => /[\u0400-\u04FF\u0600-\u06FF]/.test(node.textContent ?? ""));
    const labelsAreHtml = nodes.every((node) => node instanceof HTMLButtonElement && node.querySelector(".node-label")?.getAttribute("dir") === "auto" || node.matches("[data-map-node='central']"));
    const zoomButton = document.querySelector("button[aria-label='Zoom in']");
    zoomButton?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      forcedLayoutMs,
      nonZeroBoxes: boxes.every(({ width, height }) => width > 0 && height > 0),
      multilingualLabelCount: multilingualLabels.length,
      labelsAreHtml,
      cameraTransform: document.querySelector(".map-camera")?.style.transform ?? "",
      longTasks: window.__outmapperLongTasks ?? []
    };
  });
  await context.close();
  const maxLongTaskMs = metrics.longTasks.length === 0 ? 0 : Math.max(...metrics.longTasks);
  const accepted =
    readyMs < 2500 &&
    keyboardMs < 200 &&
    metrics.forcedLayoutMs < 100 &&
    maxLongTaskMs < 250 &&
    metrics.nodeCount === totalNodes &&
    metrics.nonZeroBoxes &&
    metrics.multilingualLabelCount > 0 &&
    metrics.labelsAreHtml &&
    metrics.cameraTransform.includes("scale");
  return {
    totalNodes,
    renderedNodes: metrics.nodeCount,
    edges: metrics.edgeCount,
    readyMs: Number(readyMs.toFixed(1)),
    keyboardMs: Number(keyboardMs.toFixed(1)),
    forcedLayoutMs: Number(metrics.forcedLayoutMs.toFixed(1)),
    longTasks: metrics.longTasks.length,
    maxLongTaskMs: Number(maxLongTaskMs.toFixed(1)),
    boxes: metrics.nonZeroBoxes,
    multilingualLabels: metrics.multilingualLabelCount,
    htmlLabels: metrics.labelsAreHtml,
    zoomApplied: metrics.cameraTransform.includes("scale"),
    accepted
  };
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
  const results = [];
  for (const totalNodes of [25, 50, 100]) results.push(await measure(browser, totalNodes));
  console.table(results);
  if (results.some(({ accepted }) => !accepted)) process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
