import { serializeCanonicalJson } from "./serialization.js";

describe("canonical serialization", () => {
  it("sorts object properties recursively while preserving array order", () => {
    const first = serializeCanonicalJson({ z: 1, a: { y: 2, b: 3 }, records: [{ z: 2, a: 1 }] });
    const second = serializeCanonicalJson({ records: [{ a: 1, z: 2 }], a: { b: 3, y: 2 }, z: 1 });

    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
  });
});
