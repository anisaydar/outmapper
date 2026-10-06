import { cp, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { findChromiumExecutable } from "./chromium-path.mjs";
import { loadServerConfig } from "../dist/server/src/server/config.js";
import { buildServer } from "../dist/server/src/server/server.js";

const port = 4326;
const origin = `http://127.0.0.1:${port}`;
const root = await mkdtemp(path.join(os.tmpdir(), "outmapper-workspace-features-"));
const projectsDirectory = path.join(root, "Projects");
const stateDirectory = path.join(root, "state");
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

async function openSettings(page, locale) {
  const label = locale === "ar" ? "الإعدادات" : "Settings";
  if (!await page.locator(".settings-popover").isVisible().catch(() => false)) await page.getByRole("button", { name: label, exact: true }).click();
  await page.locator(".settings-popover").waitFor();
}

async function applyLocaleAndTheme(page, locale, theme) {
  await openSettings(page, "en");
  if (locale === "ar") {
    await page.getByRole("button", { name: "Language: English", exact: true }).click();
    await page.getByRole("option", { name: "العربية", exact: true }).click();
    assert(await page.locator("html").getAttribute("dir") === "rtl", "Arabic did not apply RTL");
  }
  if (theme === "light") await page.getByRole("button", { name: locale === "ar" ? "فاتح" : "Light", exact: true }).click();
  assert(await page.locator("html").getAttribute("data-theme") === theme, `${locale}/${theme} theme did not apply`);
}

async function assertNoOverlap(page, selector, label) {
  const overlap = await page.locator(selector).evaluateAll((elements) => {
    const boxes = elements.map((element) => ({ name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.className, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0);
    for (let left = 0; left < boxes.length; left += 1) {
      for (let right = left + 1; right < boxes.length; right += 1) {
        const a = boxes[left].box;
        const b = boxes[right].box;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) {
          return [boxes[left].name, boxes[right].name];
        }
      }
    }
    return null;
  });
  assert(!overlap, `${label} overlap: ${JSON.stringify(overlap)}`);
}

async function assertNoCrossOverlap(page, leftSelector, rightSelector, label) {
  const overlap = await page.evaluate(({ leftSelector: left, rightSelector: right }) => {
    const boxes = (selector) => [...document.querySelectorAll(selector)].map((element) => ({ name: element.getAttribute("aria-label") ?? element.textContent?.trim(), box: element.getBoundingClientRect() })).filter(({ box }) => box.width > 0 && box.height > 0);
    for (const a of boxes(left)) for (const b of boxes(right)) {
      if (Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 1 && Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 1) return [a.name, b.name];
    }
    return null;
  }, { leftSelector, rightSelector });
  assert(!overlap, `${label} overlap: ${JSON.stringify(overlap)}`);
}

async function walkthrough({ width, height, locale, theme, projectA, projectB, projectC, errors }) {
  await request("POST", `/api/workspace/projects/${projectB.instanceId}/activate`, {});
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: "reduce", ...(width <= 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${width}/${locale}: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`${width}/${locale}: ${error.message}`));
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  await applyLocaleAndTheme(page, locale, theme);

  await page.locator(".settings-popover").getByRole("button", { name: locale === "ar" ? "الكون" : "Universe", exact: true }).click();
  await page.locator(`[data-universe-project-id='${projectB.id}']`).waitFor();
  assert(await page.locator(`[data-universe-project-id='${projectC.id}'].is-unavailable`).isVisible(), "Missing Project C was not retained in Universe");
  await assertNoOverlap(page, ".universe-node, .universe-node__label", `${width}px Universe nodes and labels`);
  assert(await page.locator(".workspace-breadcrumb").count() === 0, "Breadcrumbs are still rendered");
  await page.locator(`[data-universe-project-id='${projectB.id}']`).focus();
  await page.keyboard.press("Enter");
  // The selected Project shows in the side panel; on phones it is the second tab.
  if (width <= 390) await page.locator(".mobile-tabs button").nth(1).click();
  await page.locator(".universe-panel h1").filter({ hasText: "Project B" }).waitFor();
  await page.locator(".universe-panel .pill--accent").click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  await page.locator(".map-actions .tool").nth(0).click();
  await page.locator(`[data-universe-project-id='${projectB.id}']`).waitFor();
  await page.locator(".map-actions .tool").nth(1).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();

  const incomingA = page.locator(".map-node--portal[data-portal-direction='incoming']").filter({ hasText: "Project A" });
  await incomingA.waitFor();
  await assertNoOverlap(page, ".map-node--portal", `${width}px portal nodes`);
  await assertNoCrossOverlap(page, ".map-node--portal", ".central-node, .map-node--issue, .map-node--topic", `${width}px portals and Topic graph`);
  await incomingA.click();
  await page.locator(".portal-preview .pill--accent").click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();
  await page.locator(".map-actions .tool").nth(0).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();

  // The header Universe button is a toggle: pressed again, it returns to the Topic it was opened from.
  const universeToggle = page.locator(".app-bar__start .tool").nth(1);
  await universeToggle.click();
  await page.locator(".universe-node--center").waitFor();
  assert(await universeToggle.getAttribute("aria-pressed") === "true", "Universe button is not pressed in the Universe");
  await universeToggle.click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  assert(await universeToggle.getAttribute("aria-pressed") === "false", "Universe button stayed pressed");

  await page.locator(".app-bar__start .tool").nth(0).click();
  await page.locator(".search-scope button").nth(1).click();
  await page.locator(".search-input-row input").fill("Atlas A");
  const result = page.locator(".search-result").filter({ hasText: "Atlas A" }).first();
  await result.waitFor();
  assert((await result.textContent()).includes("Project A"), "Federated result did not show its source Project");
  assert(await page.locator(".search-notes").isVisible(), "Missing Project search note was not shown");
  await result.click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();
  await page.locator(".map-actions .tool").nth(0).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectB.topic.id}']`).waitFor();
  await page.locator(".map-actions .tool").nth(1).click();
  await page.locator(`[data-map-node='central'][data-entity-id='${projectA.topic.id}']`).waitFor();

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight);
  assert(!overflow, `${width}px ${locale}/${theme} document overflow`);
  await context.close();
}

const initialProjectDirectory = path.join(root, "initial-project");
await cp(path.resolve("fixtures/projects/ai-landscape"), initialProjectDirectory, { recursive: true });
await rm(path.join(initialProjectDirectory, ".outmapper"), { recursive: true, force: true });

const server = await buildServer({
  ...loadServerConfig({}, process.cwd()),
  projectDirectory: initialProjectDirectory,
  projectsDirectory,
  stateDirectory,
  clientDirectory: path.resolve("dist/client"),
  port
});

try {
  await mkdir(projectsDirectory, { recursive: true });
  await server.listen({ host: "127.0.0.1", port });
  const projectA = await createProject("Project A", "Atlas A", "Bridge A");
  const projectB = await createProject("Project B", "Atlas B", "Bridge B");
  const projectC = await createProject("Project C", "Atlas C", "Bridge C");
  await request("POST", `/api/workspace/projects/${projectA.instanceId}/activate`, {});
  await request("POST", "/api/project-links", { sourceTopicId: projectA.topic.id, keyIssueId: projectA.issue.id, targetProjectId: projectB.id, cachedProjectTitle: "Project B" });
  await request("POST", `/api/workspace/projects/${projectC.instanceId}/activate`, {});
  await request("POST", "/api/project-links", { sourceTopicId: projectC.topic.id, keyIssueId: projectC.issue.id, targetProjectId: projectB.id, cachedProjectTitle: "Project B" });
  await request("POST", `/api/workspace/projects/${projectB.instanceId}/activate`, {});
  const missingC = path.join(root, "missing-project-c");
  await rename(projectC.directory, missingC);
  await request("POST", "/api/workspace/refresh", {});

  browser = await chromium.launch({ executablePath: findChromiumExecutable(), headless: true });
  const errors = [];
  await walkthrough({ width: 1440, height: 900, locale: "en", theme: "dark", projectA, projectB, projectC, errors });
  await walkthrough({ width: 390, height: 844, locale: "ar", theme: "light", projectA, projectB, projectC, errors });

  for (const testCase of [{ width: 1440, height: 900, locale: "ar", theme: "light" }, { width: 390, height: 844, locale: "en", theme: "dark" }]) {
    await request("POST", `/api/workspace/projects/${projectB.instanceId}/activate`, {});
    const context = await browser.newContext({ viewport: { width: testCase.width, height: testCase.height }, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") errors.push(`${testCase.width}/${testCase.locale}: ${message.text()}`); });
    page.on("pageerror", (error) => errors.push(`${testCase.width}/${testCase.locale}: ${error.message}`));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.locator("[data-map-ready='true']").waitFor();
    await applyLocaleAndTheme(page, testCase.locale, testCase.theme);
    await page.locator(".settings-popover").getByRole("button", { name: testCase.locale === "ar" ? "الكون" : "Universe", exact: true }).click();
    await page.locator(".universe-node").first().waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert(!overflow, `${testCase.width}px ${testCase.locale}/${testCase.theme} horizontal overflow`);
    await context.close();
  }

  assert(errors.length === 0, `Browser console errors: ${JSON.stringify(errors)}`);
  console.log(JSON.stringify({ walkthroughs: ["1440x900 en dark", "390x844 ar light"], additionalStates: ["1440x900 ar light", "390x844 en dark"], universe: "passed", incomingPortal: "passed", federatedSearch: "passed", backForward: "passed", missingProject: "passed", overlap: "passed", overflow: "passed" }));
} finally {
  await browser?.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
}
