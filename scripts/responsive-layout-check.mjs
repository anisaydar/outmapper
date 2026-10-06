import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";

const port = 4324;
const origin = `http://127.0.0.1:${port}`;
const chromePath = findChromiumExecutable();
const timestamp = "2026-09-30T00:00:00.000Z";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function responsiveProject(totalNodes = 100) {
  const issueCount = 10;
  const relatedCount = totalNodes - issueCount - 1;
  const labels = [
    "Responsible deployment across public institutions and critical infrastructure",
    "حوكمة النماذج والأنظمة الذكية متعددة اللغات",
    "Интерпретируемость высоконагруженных интеллектуальных систем",
    "Arabic العربية with Latin API terminology and identifiers",
    "Русский текст with English model names and evaluation metrics"
  ];
  const topics = [{ id: "topic-center", title: "Multilingual responsive systems", createdAt: timestamp, updatedAt: timestamp }];
  for (let index = 0; index < relatedCount; index += 1) {
    topics.push({ id: `topic-${index}`, title: `${labels[index % labels.length]} ${index + 1}`, createdAt: timestamp, updatedAt: timestamp });
  }
  const keyIssues = Array.from({ length: issueCount }, (_, index) => ({
    id: `issue-${index}`,
    topicId: "topic-center",
    title: `${labels[(index + 1) % labels.length]} — ${index + 1}`,
    order: index,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  const relationships = Array.from({ length: relatedCount }, (_, index) => ({
    id: `relationship-${index}`,
    sourceTopicId: "topic-center",
    keyIssueId: `issue-${index % issueCount}`,
    targetTopicId: `topic-${index}`,
    order: index,
    createdAt: timestamp,
    updatedAt: timestamp
  }));
  return {
    manifest: { format: "outmapper-project", formatVersion: 2, id: "responsive-layout-check", title: "Responsive Layout Check", createdAt: timestamp, updatedAt: timestamp, revision: 0, homeTopicId: "topic-center" },
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
    try { if ((await fetch(`${origin}/api/health`)).ok) return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("Responsive layout check server did not start");
}

async function pageFor(browser, options) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  await page.route("**/api/project", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(responsiveProject()) }));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  return { context, page };
}

async function panelContrast(page) {
  return page.locator(".panel-card").evaluate((element) => {
    const parse = (value) => (value.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
    const luminance = (value) => {
      const channels = parse(value).map((channel) => channel / 255).map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const style = getComputedStyle(element);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
  });
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

  const desktop = await pageFor(browser, { viewport: { width: 1440, height: 960 }, colorScheme: "dark", reducedMotion: "reduce" });
  assert(await desktop.page.locator(".map-stage").isVisible(), "Desktop Map is not visible");
  assert(await desktop.page.locator(".knowledge-panel").isVisible(), "Desktop Knowledge panel is not visible");
  assert((await desktop.page.locator("[data-map-node]").count()) === 100, "Desktop lost graph nodes");
  const reducedDuration = await desktop.page.locator("[data-map-node='topic']").first().evaluate((node) => getComputedStyle(node).transitionDuration);
  const reducedSeconds = reducedDuration.split(",").map((value) => value.trim()).map((value) => value.endsWith("ms") ? Number.parseFloat(value) / 1000 : Number.parseFloat(value));
  assert(reducedSeconds.every((value) => value <= 0.001), "Reduced-motion CSS was not applied");
  const darkContrast = await panelContrast(desktop.page);
  assert(darkContrast >= 4.5, "Dark theme panel text contrast is below 4.5:1");
  await desktop.context.close();

  const tablet = await pageFor(browser, { viewport: { width: 1024, height: 768 }, colorScheme: "light" });
  assert(await tablet.page.locator(".map-stage").isVisible(), "Tablet Map is not visible");
  assert(await tablet.page.locator(".knowledge-panel").isVisible(), "Tablet split Knowledge panel is not visible");
  assert((await tablet.page.locator(".mobile-tabs").evaluate((node) => getComputedStyle(node).display)) === "none", "Tablet unexpectedly entered the phone switcher");
  const lightContrast = await panelContrast(tablet.page);
  assert(lightContrast >= 4.5, "Light theme panel text contrast is below 4.5:1");
  await tablet.context.close();

  const mobile = await pageFor(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: "dark" });
  const page = mobile.page;
  const cdp = await mobile.context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  assert(await page.locator(".map-stage").isVisible(), "Mobile Map is not visible");
  assert(!(await page.locator(".knowledge-panel").isVisible()), "Mobile surfaces were not separated");
  assert(await page.locator(".mobile-tabs").isVisible(), "Mobile switcher is missing");
  const mapSurface = page.locator(".map-surface");
  const surfaceBox = await mapSurface.boundingBox();
  assert(surfaceBox, "Mobile map has no bounds");
  const backgroundPoint = await mapSurface.evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    for (let y = bounds.top + 80; y < bounds.bottom - 100; y += 40) {
      for (let x = bounds.left + 100; x < bounds.right - 100; x += 30) {
        const targets = [document.elementFromPoint(x - 35, y), document.elementFromPoint(x + 35, y)];
        if (targets.every((target) => target?.closest(".map-surface") && !target.closest("button"))) return { x, y };
      }
    }
    return null;
  });
  assert(backgroundPoint, "Mobile map has no unobstructed pinch target");
  const centerX = backgroundPoint.x;
  const centerY = backgroundPoint.y;
  const beforePinch = await page.locator(".map-camera").evaluate((node) => getComputedStyle(node).transform);
  const touchPoint = (id, x) => ({ id, x, y: centerY, radiusX: 5, radiusY: 5, force: 1 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [touchPoint(1, centerX - 35), touchPoint(2, centerX + 35)] });
  for (const distance of [45, 55, 65, 75, 85]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [touchPoint(1, centerX - distance), touchPoint(2, centerX + distance)] });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(100);
  const afterPinch = await page.locator(".map-camera").evaluate((node) => getComputedStyle(node).transform);
  const touchDiagnostics = await page.evaluate(({ before, after }) => ({ maxTouchPoints: globalThis.navigator.maxTouchPoints, zoom: document.querySelector(".map-surface")?.dataset.zoom, before, after }), { before: beforePinch, after: afterPinch });
  assert(afterPinch !== beforePinch, `Pinch did not change the map camera: ${JSON.stringify(touchDiagnostics)}`);

  const touchTarget = await page.locator("[data-map-node='topic']").evaluateAll((nodes) => {
    for (const node of nodes) {
      const bounds = node.getBoundingClientRect();
      const x = bounds.left + bounds.width / 2;
      const y = bounds.top + bounds.height / 2;
      if (document.elementFromPoint(x, y)?.closest("[data-map-node='topic']") === node) {
        return { id: node.getAttribute("data-entity-id"), x, y, width: bounds.width, height: bounds.height };
      }
    }
    return null;
  });
  assert(touchTarget?.id, "Dense mobile map has no unobstructed Related Topic touch target");
  const relatedId = touchTarget.id;
  const relatedBox = { width: touchTarget.width, height: touchTarget.height };
  await page.touchscreen.tap(touchTarget.x, touchTarget.y);
  await page.locator(`[data-map-node='central'][data-entity-id='${relatedId}']`).waitFor();
  assert((await page.locator(".topic-preview").count()) === 0, "Related Topic touch opened an intermediate preview");
  assert(relatedBox.width >= 44 && relatedBox.height >= 44, `Related Topic touch target is below 44px: ${JSON.stringify(relatedBox)}`);

  await page.getByRole("button", { name: "Back" }).click();
  await page.locator("[data-map-node='central'][data-entity-id='topic-center']").waitFor();
  const restoredRelated = page.locator(`[data-map-node='topic'][data-entity-id='${relatedId}']`);
  const geometryBefore = await restoredRelated.getAttribute("style");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Language: English" }).click();
  await page.getByRole("option", { name: "العربية", exact: true }).click();
  assert((await page.locator("html").getAttribute("dir")) === "rtl", "Arabic did not apply RTL");
  assert((await restoredRelated.getAttribute("style")) === geometryBefore, "RTL altered graph geometry");
  await page.getByRole("button", { name: "اللغة: العربية", exact: true }).click();
  await page.getByRole("option", { name: "Русский", exact: true }).click();
  assert((await page.locator("html").getAttribute("dir")) === "ltr", "Russian did not restore LTR");
  const noHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert(noHorizontalOverflow, "Long multilingual labels caused document overflow");
  await page.getByRole("button", { name: "Настройки", exact: true }).click();

  await page.locator(".mobile-tabs button").nth(1).click();
  assert(await page.locator(".knowledge-panel").isVisible(), "Mobile Knowledge surface did not open");
  await page.getByRole("button", { name: "Редактировать", exact: true }).click();
  assert(await page.getByLabel("Название", { exact: true }).isVisible(), "Mobile Studio metadata editing is unavailable");
  assert(await page.getByLabel("Прикрепить файл").isVisible(), "Mobile attachment workflow is unavailable");
  const result = {
    desktop: "split-100-nodes",
    tablet: "split-100-nodes",
    mobile: "switcher-100-nodes",
    touchPinch: "passed",
    touchTarget: `${Math.round(relatedBox.width)}x${Math.round(relatedBox.height)}`,
    directTopicNavigation: "passed",
    reducedMotion: reducedDuration,
    contrast: { dark: Number(darkContrast.toFixed(2)), light: Number(lightContrast.toFixed(2)) },
    rtlGeometry: "stable",
    russianWrapping: "passed",
    mobileStudio: "passed",
    accepted: true
  };
  console.log(JSON.stringify(result));
  await mobile.context.close();
} finally {
  await browser?.close();
  server.kill();
}
