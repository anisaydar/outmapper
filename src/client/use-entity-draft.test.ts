import { DraftController, type DraftAck } from "./use-entity-draft.js";

type Text = { title: string; description: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(canSave?: (field: keyof Text, value: string) => boolean) {
  const controller = new DraftController<Text>({ title: "Center", description: "" }, 1, { debounceMs: 600, canSave });
  const calls: Array<{ patch: Partial<Text>; reply: ReturnType<typeof deferred<DraftAck<Text>>> }> = [];
  controller.setSaver((patch) => {
    const reply = deferred<DraftAck<Text>>();
    calls.push({ patch, reply });
    return reply.promise;
  });
  return { controller, calls };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("entity draft controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounces saves, keeps one request in flight, and saves text typed during it afterwards", async () => {
    const { controller, calls } = setup();
    controller.set("description", "Hel");
    await vi.advanceTimersByTimeAsync(599);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map(({ patch }) => patch)).toEqual([{ description: "Hel" }]);

    controller.set("description", "Hello wor");
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toHaveLength(1);
    controller.set("description", "Hello world");
    calls[0].reply.resolve({ revision: 2, values: { description: "Hel" } });
    await settle();
    expect(controller.getSnapshot().values.description).toBe("Hello world");
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(600);
    expect(calls.map(({ patch }) => patch)).toEqual([{ description: "Hel" }, { description: "Hello world" }]);
    calls[1].reply.resolve({ revision: 3, values: { description: "Hello world" } });
    await settle();
    expect(controller.dirty).toBe(false);
  });

  it("saves again right after an ack when typing paused during the request", async () => {
    const { controller, calls } = setup();
    controller.set("title", "Machine");
    await vi.advanceTimersByTimeAsync(600);
    controller.set("title", "Machine Intelligence");
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toHaveLength(1);
    calls[0].reply.resolve({ revision: 2, values: { title: "Machine" } });
    await settle();
    expect(calls.map(({ patch }) => patch.title)).toEqual(["Machine", "Machine Intelligence"]);
  });

  it("keeps the local draft when the server normalizes an acknowledged value", async () => {
    const { controller, calls } = setup();
    controller.set("title", "Machine ");
    const flushed = controller.flush();
    calls[0].reply.resolve({ revision: 2, values: { title: "Machine" } });
    expect(await flushed).toBe(true);
    controller.receive({ title: "Machine", description: "" }, 2);
    expect(controller.getSnapshot().values.title).toBe("Machine ");
    expect(controller.dirty).toBe(false);
  });

  it("replaces only fields that are not dirty and ignores values that predate the last ack", async () => {
    const { controller, calls } = setup();
    controller.set("description", "Unsaved draft");
    controller.receive({ title: "Renamed elsewhere", description: "Server text" }, 2);
    expect(controller.getSnapshot().values).toEqual({ title: "Renamed elsewhere", description: "Unsaved draft" });

    const flushed = controller.flush();
    controller.receive({ title: "Stale", description: "Stale" }, 2);
    calls[0].reply.resolve({ revision: 3, values: { description: "Unsaved draft" } });
    expect(await flushed).toBe(true);
    controller.receive({ title: "Older", description: "Older" }, 2);
    expect(controller.getSnapshot().values).toEqual({ title: "Renamed elsewhere", description: "Unsaved draft" });
  });

  it("flush resolves false for drafts that cannot be saved and for failed saves, and retries on the next flush", async () => {
    const { controller, calls } = setup((field, value) => field !== "title" || value.trim().length > 0);
    controller.set("title", " ");
    expect(await controller.flush()).toBe(false);
    expect(calls).toHaveLength(0);

    controller.set("title", "Valid");
    const failed = controller.flush();
    calls[0].reply.reject(new Error("offline"));
    expect(await failed).toBe(false);
    expect(controller.getSnapshot().error).toBe(true);
    const retried = controller.flush();
    calls[1].reply.resolve({ revision: 2, values: { title: "Valid" } });
    expect(await retried).toBe(true);
    expect(controller.getSnapshot().error).toBe(false);
  });

  it("adopts server values on resync and cancels the pending autosave", async () => {
    const { controller, calls } = setup();
    const changed = vi.fn();
    controller.setExternalChangeHandler(changed);
    controller.set("title", "Pending");
    controller.resync({ title: "Undone", description: "" }, 5);
    expect(changed).toHaveBeenCalledWith(["title"]);
    expect(controller.getSnapshot().values.title).toBe("Undone");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(0);
  });
});
