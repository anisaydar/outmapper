/** A stable hue per entity, used by the default disc artwork when no cover image is set. */
export function discHue(id: string): number {
  if (id === "topic-ai") return 0;
  return [...id].reduce((total, character) => total + character.codePointAt(0)!, 0) % 360;
}

/** The SVG transform that sets an arrowhead tip at a point, pointing along an angle in degrees. */
export function arrowheadTransform({ x, y, angle }: { x: number; y: number; angle: number }): string {
  return `translate(${x} ${y}) rotate(${angle})`;
}

export function wrapLabel(title: string, length: number): string[] {
  const lines = [""];
  for (const word of title.split(" ")) {
    const last = lines.length - 1;
    const next = `${lines[last]} ${word}`.trim();
    if (next.length > length && lines[last]) lines.push(word);
    else lines[last] = next;
  }
  return lines;
}
