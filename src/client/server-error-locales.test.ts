import { localizeServerError } from "./server-error-locales.js";

describe("server error localization", () => {
  it("maps stable error codes in every supported locale", () => {
    expect(localizeServerError("active-project-forget", "en", "fallback")).toBe("The open Project cannot be forgotten.");
    expect(localizeServerError("active-project-forget", "ar", "fallback")).toContain("المشروع");
    expect(localizeServerError("active-project-forget", "ru", "fallback")).toContain("проект");
    expect(localizeServerError("workspace-search-failed", "ar", "fallback")).not.toBe("fallback");
    expect(localizeServerError("workspace-search-failed", "ru", "fallback")).not.toBe("fallback");
    const packageCodes = ["archive-limit", "asset-integrity", "cancelled", "destination-exists", "encrypted-entry", "integrity", "invalid-archive", "invalid-asset", "invalid-manifest", "path-collision", "plan-not-found", "snapshot-integrity", "special-entry", "split-archive", "unsafe-destination", "unsafe-path"];
    for (const code of packageCodes) {
      expect(localizeServerError(code, "en", "fallback")).not.toBe("fallback");
      expect(localizeServerError(code, "ar", "fallback")).not.toBe("fallback");
      expect(localizeServerError(code, "ru", "fallback")).not.toBe("fallback");
    }
  });

  it("keeps the English server message as the fallback for unknown codes", () => {
    expect(localizeServerError("future-code", "ar", "English detail")).toBe("English detail");
    expect(localizeServerError(undefined, "ru", "English detail")).toBe("English detail");
  });
});
