import { existsSync } from "node:fs";

const candidates = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge"
  ]
};

export function findChromiumExecutable(environment = process.env, platform = process.platform) {
  const configured = environment.OUTMAPPER_BROWSER_PATH;
  if (configured && existsSync(configured)) return configured;
  const discovered = candidates[platform]?.find(existsSync);
  if (discovered) return discovered;
  throw new Error("A Chromium-based browser was not found. Set OUTMAPPER_BROWSER_PATH to its executable.");
}
