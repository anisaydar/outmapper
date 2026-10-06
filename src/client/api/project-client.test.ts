import { projectApi, projectLibraryApi } from "./project-client.js";

function lastRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, method: init.method, body: init.body, headers: init.headers as Record<string, string> };
}

describe("project client requests", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ project: {}, history: { canUndo: true, canRedo: false } }), { status: 200, headers: { "Content-Type": "application/json" } }));

  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["relationship", () => projectApi.disconnectRelationship("relationship-1"), "/api/relationships/relationship-1"],
    ["Project link", () => projectApi.unlinkProject("link-1"), "/api/project-links/link-1"]
  ])("sends a %s DELETE without a body or a JSON Content-Type", async (_name, send, url) => {
    await send();
    const request = lastRequest(fetchMock);
    expect(request).toMatchObject({ url, method: "DELETE", body: undefined });
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("content-type");
    expect(request.headers.Accept).toBe("application/json");
  });

  it("keeps the JSON Content-Type on requests that carry a body", async () => {
    await projectApi.createTopic({ title: "New Topic" });
    expect(lastRequest(fetchMock).headers["Content-Type"]).toBe("application/json");
    await projectApi.deleteTopic("topic-1");
    expect(lastRequest(fetchMock)).toMatchObject({ method: "DELETE", body: JSON.stringify({ removeReferences: true }) });
    expect(lastRequest(fetchMock).headers["Content-Type"]).toBe("application/json");
  });

  it("reads the workspace with a plain GET", async () => {
    await projectLibraryApi.workspace();
    const request = lastRequest(fetchMock);
    expect(request.method).toBeUndefined();
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain("content-type");
  });
});
