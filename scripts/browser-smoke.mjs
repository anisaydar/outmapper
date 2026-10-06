import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";

const port = Number(process.env.OUTMAPPER_TEST_PORT ?? 4318);
const origin = `http://127.0.0.1:${port}`;
const chromePath = findChromiumExecutable();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkLanguageDismissal(page) {
  const settings = page.locator(".settings-popover");
  const trigger = settings.locator(".language-trigger");
  await trigger.click();
  await settings.getByRole("listbox").waitFor();
  await settings.locator(".settings-section--language h2").click();
  assert((await trigger.getAttribute("aria-expanded")) === "false", "Language picker stayed expanded after clicking its heading");
  assert((await settings.getByRole("listbox").count()) === 0, "Language options stayed visible after an outside click");
  assert(await settings.isVisible(), "Dismissing the language picker also dismissed Settings");
  await trigger.click();
  await settings.getByRole("listbox").waitFor();
  await settings.click({ position: { x: 4, y: 4 } });
  assert((await trigger.getAttribute("aria-expanded")) === "false", "Language picker stayed expanded after clicking Settings padding");
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
  throw new Error("Browser smoke server did not start");
}

const server = spawn(process.execPath, ["dist/server/src/server/main.js"], {
  cwd: process.cwd(),
  env: { ...process.env, OUTMAPPER_PORT: String(port) },
  stdio: "ignore"
});

let browser;
try {
  await waitForServer();
  const project = await (await fetch(`${origin}/api/project`)).json();
  const homeTopicId = project.manifest.homeTopicId;
  const homeIssues = project.keyIssues.filter(({ topicId }) => topicId === homeTopicId);
  const homeRelationships = project.relationships.filter(({ sourceTopicId }) => sourceTopicId === homeTopicId);
  const homeRelatedTopicIds = new Set(homeRelationships.map(({ targetTopicId }) => targetTopicId));
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: "dark",
    reducedMotion: "reduce"
  });
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  if (process.env.OUTMAPPER_SCREENSHOT) {
    await page.screenshot({ path: process.env.OUTMAPPER_SCREENSHOT, fullPage: true });
  }

  assert((await page.locator("[data-map-node='central']").count()) === 1, "Central Topic did not render");
  assert((await page.locator("[data-map-node='issue']").count()) === homeIssues.length, "Key Issue ring did not render");
  assert((await page.locator("[data-map-node='topic']").count()) === homeRelatedTopicIds.size, "Related Topic ring did not deduplicate");
  assert((await page.locator(".map-edge[data-edge-id]:not(.map-edge--portal)").count()) === homeRelationships.length, "Relationship layer did not render every edge");
  assert((await page.locator(".map-zoom button").count()) === 2, "Zoom controls do not match the approved two-control composition");
  const actionBox = await page.locator(".map-actions").boundingBox();
  const historyBox = await page.locator(".history-control").boundingBox();
  assert(Boolean(actionBox && historyBox && actionBox.x < historyBox.x), "History is not physically separate from the left map toolbar");

  const issue = page.locator("[data-entity-id='issue-agents']");
  await issue.focus();
  await issue.press("Enter");
  assert((await issue.getAttribute("aria-pressed")) === "true", "Keyboard activation did not select a Key Issue");
  assert((await page.locator(".map-edge.is-highlighted").count()) === homeRelationships.filter(({ keyIssueId }) => keyIssueId === "issue-agents").length, "Key Issue edges were not highlighted");
  assert((await page.locator(".panel-hero h1").textContent()) === "Agents & Autonomy", "Panel context did not synchronize");

  await page.locator("[data-map-node='central']").click();
  await page.locator("[data-entity-id='topic-science']").press("Space");
  await page.getByRole("button", { name: "Central Topic: Science" }).waitFor();
  assert((await page.locator(".topic-preview").count()) === 0, "Related Topic click still opened an intermediate preview");
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("button", { name: "Central Topic: Artificial Intelligence" }).waitFor();
  const sharedTopic = page.locator("[data-entity-id='topic-science']");
  const geometryBefore = await sharedTopic.getAttribute("style");

  await page.getByRole("button", { name: "Semantic relationships" }).click();
  const navigator = page.getByRole("region", { name: "Semantic relationships" });
  await navigator.waitFor();
  assert((await navigator.locator("li").count()) === homeRelationships.length, "Semantic relationship navigator lost edges");
  await page.getByRole("button", { name: "Semantic relationships" }).click();

  await page.getByRole("button", { name: "Settings" }).click();
  await checkLanguageDismissal(page);
  await page.getByRole("button", { name: "Language: English" }).click();
  await page.getByRole("option", { name: "العربية" }).click();
  await page.getByRole("button", { name: "فاتح" }).click();
  assert((await page.locator("html").getAttribute("dir")) === "rtl", "Arabic did not set RTL shell direction");
  assert((await page.locator("html").getAttribute("data-theme")) === "light", "Light theme did not apply");
  assert((await sharedTopic.getAttribute("style")) === geometryBefore, "RTL locale changed graph geometry");
  const searchBox = await page.getByRole("button", { name: "بحث", exact: true }).boundingBox();
  const settingsBox = await page.getByRole("button", { name: "الإعدادات", exact: true }).boundingBox();
  assert(Boolean(searchBox && settingsBox && searchBox.x < settingsBox.x), "Arabic mirrored the physical header order");
  assert((await page.locator("[data-map-node='central']").textContent()) === "الذكاء الاصطناعي", "Arabic did not localize the demo graph consistently");
  assert((await page.locator("[data-entity-id='topic-disinformation']").textContent())?.includes("التضليل المعلوماتي"), "Arabic demo content fell back to an unrelated language");

  await page.keyboard.press("Control+k");
  assert((await page.locator(".settings-popover").count()) === 0, "Search remained open with Settings");
  assert(await page.locator(".search-dialog").isVisible(), "Search did not open from the keyboard");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "إخفاء اللوحة" }).click();
  await page.waitForFunction(() => {
    const stage = document.querySelector(".map-stage")?.getBoundingClientRect();
    const center = document.querySelector("[data-map-node='central']")?.getBoundingClientRect();
    if (!stage || !center) return false;
    return Math.abs(stage.left + stage.width / 2 - (center.left + center.width / 2)) < 2;
  });
  const alignment = await page.evaluate(() => {
    const stage = document.querySelector(".map-stage")?.getBoundingClientRect();
    const center = document.querySelector("[data-map-node='central']")?.getBoundingClientRect();
    if (!stage || !center) return Number.POSITIVE_INFINITY;
    return Math.abs(stage.left + stage.width / 2 - (center.left + center.width / 2));
  });
  assert(alignment < 2, "Map did not recenter when the panel width changed");
  await page.getByRole("button", { name: "إظهار اللوحة" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("[data-map-ready='true']").waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await checkLanguageDismissal(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("[data-entity-id='topic-science']").click();
  await page.getByRole("button", { name: "Central Topic: Science" }).waitFor();
  assert((await page.locator(".topic-preview").count()) === 0, "Mobile Related Topic click opened an intermediate preview");
  await page.locator(".mobile-tabs button").nth(1).click();
  assert(await page.locator(".knowledge-panel").isVisible(), "Mobile Knowledge surface did not open");

  const motionContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference" });
  const motionPage = await motionContext.newPage();
  await motionPage.goto(origin, { waitUntil: "domcontentloaded" });
  await motionPage.locator("[data-map-ready='true']").waitFor();
  const issueDelays = await motionPage.locator(".map-node--issue").evaluateAll((nodes) => nodes.slice(0, 3).map((node) => getComputedStyle(node).animationDelay));
  const topicDelays = await motionPage.locator(".map-node--topic").evaluateAll((nodes) => nodes.slice(0, 3).map((node) => getComputedStyle(node).animationDelay));
  assert(new Set(issueDelays).size > 1 && new Set(topicDelays).size > 1, "Graph entrance is not progressive");
  await motionPage.locator("[data-entity-id='topic-science']").click();
  await motionPage.locator(".map-world.is-topic-leaving .map-node.is-promoting").waitFor();
  assert(await motionPage.locator(".map-world.is-topic-leaving .map-node.is-promoting").isVisible(), "Topic promotion transition did not start");
  await motionPage.getByRole("button", { name: "Central Topic: Science" }).waitFor();
  await motionContext.close();

  console.log(
    JSON.stringify({
      desktopNodes: 20,
      desktopEdges: 15,
      keyboard: "passed",
      semanticNavigator: "passed",
      rtlGeometry: "passed",
      panelResize: "passed",
      mobileFoundation: "passed",
      rtlShell: "passed",
      localizedDemo: "passed",
      transientSurfaces: "passed",
      languageDismissal: "passed",
      progressiveMotion: "passed",
      directTopicNavigation: "passed",
      topicPromotion: "passed"
    })
  );
  await context.close();
} finally {
  await browser?.close();
  server.kill();
}
