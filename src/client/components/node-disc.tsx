/**
 * The circular node artwork in a 184×184 viewBox: the default gradient disc with faint orbit rings, the cover image
 * on top when there is one, and a shade so a title can sit on it. The caller adds the ring and any title.
 */
export function DiscArtwork({ id, hue, coverImageUrl, shade = true }: { id: string; hue: number; coverImageUrl?: string; shade?: boolean }) {
  return <>
    <defs>
      <clipPath id={`${id}-clip`}><circle cx="92" cy="92" r="90" /></clipPath>
      <linearGradient id={`${id}-gradient`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor={`hsl(${hue} 62% 32%)`} />
        <stop offset="1" stopColor={`hsl(${(hue + 50) % 360} 55% 9%)`} />
      </linearGradient>
    </defs>
    <g clipPath={`url(#${id}-clip)`}>
      <g transform="translate(-18 -18) scale(1.03)">
        <rect width="220" height="220" fill={`url(#${id}-gradient)`} />
        {Array.from({ length: 16 }, (_, index) => (
          <circle key={index} cx={(index * 131) % 220} cy={(index * 67) % 220} r={12 + index * 7} fill="none" stroke={`hsl(${hue} 80% 72%)`} strokeOpacity=".15" />
        ))}
      </g>
      {coverImageUrl ? <image key={coverImageUrl} href={coverImageUrl} x="2" y="2" width="180" height="180" preserveAspectRatio="xMidYMid slice" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
      {shade ? <circle className="central-cover-shade" cx="92" cy="92" r="92" fill={coverImageUrl ? "var(--cover-shade)" : "#0007"} /> : null}
    </g>
  </>;
}
