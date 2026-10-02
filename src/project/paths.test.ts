import path from "node:path";
import { normalizeProjectPath, resolveProjectPath } from "./paths.js";

describe("Project path confinement", () => {
  it("normalizes safe Project-relative paths", () => {
    expect(normalizeProjectPath("content\\notes\\entry.md")).toBe("content/notes/entry.md");
    expect(resolveProjectPath("C:\\projects\\one", "assets/image.png")).toBe(
      path.resolve("C:\\projects\\one", "assets", "image.png")
    );
  });

  it.each(["../outside", "content/../../outside", "C:\\outside.txt", "/etc/passwd", "content//file"])(
    "rejects unsafe path %s",
    (unsafePath) => {
      expect(() => normalizeProjectPath(unsafePath)).toThrow();
    }
  );
});
