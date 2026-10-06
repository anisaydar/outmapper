import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log(JSON.stringify({ windowsFolderPicker: "skipped", platform: process.platform }));
  process.exit(0);
}

const { WINDOWS_FOLDER_PICKER_COMPILE_CHECK_SCRIPT } = await import("../dist/server/src/server/native-folder-picker.js");
const output = execFileSync("powershell.exe", [
  "-NoProfile",
  "-NonInteractive",
  "-EncodedCommand",
  Buffer.from(WINDOWS_FOLDER_PICKER_COMPILE_CHECK_SCRIPT, "utf16le").toString("base64")
], { encoding: "utf8", windowsHide: true, timeout: 120_000 });

if (output.trim() !== "Pick") throw new Error(`Windows folder picker C# did not compile: ${output}`);
console.log(JSON.stringify({ windowsFolderPicker: "compiled" }));
