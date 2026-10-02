import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const target = path.join(projectRoot, "dist", "server");
if (path.basename(target) !== "server" || path.basename(path.dirname(target)) !== "dist") {
  throw new Error(`Refusing to clean unexpected build directory: ${target}`);
}
await rm(target, { recursive: true, force: true });
