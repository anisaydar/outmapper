import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/{domain,graph,project,search,server}/**/*.test.ts"]
        }
      },
      {
        test: {
          name: "client",
          environment: "jsdom",
          setupFiles: ["./src/test/setup.ts"],
          include: ["src/client/**/*.test.{ts,tsx}"]
        }
      }
    ]
  }
});
