function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, sortValue(child)])
  );
}

export function serializeCanonicalJson(value: unknown): string {
  const serialized = JSON.stringify(sortValue(value), null, 2);
  if (serialized === undefined) throw new TypeError("Canonical JSON value is not serializable");
  return `${serialized}\n`;
}
