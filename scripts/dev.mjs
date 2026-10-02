import { spawn } from "node:child_process";

const processes = [
  spawn("npm", ["run", "dev:server"], { shell: true, stdio: "inherit" }),
  spawn("npm", ["run", "dev:client"], { shell: true, stdio: "inherit" })
];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  process.exitCode = code;
};

for (const child of processes) {
  child.on("exit", (code) => {
    if (!stopping && code !== null && code !== 0) stop(code);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
