import type { SVGProps } from "react";

export type IconName =
  | "search"
  | "settings"
  | "map"
  | "knowledge"
  | "list"
  | "panel"
  | "plus"
  | "minus"
  | "reset"
  | "close"
  | "back"
  | "home"
  | "chevronDown"
  | "chevronRight"
  | "check"
  | "clock"
  | "edit"
  | "sun"
  | "moon"
  | "pin"
  | "grip"
  | "upload"
  | "trash"
  | "up"
  | "down"
  | "folder"
  | "download"
  | "package"
  | "alert"
  | "success"
  | "open"
  | "undo"
  | "redo"
  | "more"
  | "universe";

const paths: Record<IconName, React.ReactNode> = {
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h8M17 7h3M4 17h3M12 17h8" />
      <circle cx="14.5" cy="7" r="2.3" />
      <circle cx="9.5" cy="17" r="2.3" />
    </>
  ),
  map: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8.5" />
    </>
  ),
  knowledge: (
    <>
      <rect x="4.5" y="4" width="15" height="16" rx="3" />
      <path d="M8.5 9h7M8.5 13h7M8.5 17h4" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  ),
  panel: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3.5" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  reset: (
    <>
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M7 10v9h10v-9" />
    </>
  ),
  close: (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>
  ),
  back: <path d="M15 5l-7 7 7 7" />,
  home: (
    <>
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6.5 9.5V19h11V9.5" />
    </>
  ),
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronRight: <path d="M9 6l6 6-6 6" />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clock: (
    <>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4.5v4h4" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  edit: <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  pin: <path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" />,
  grip: (
    <>
      <circle cx="9" cy="7" r="1" />
      <circle cx="15" cy="7" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="17" r="1" />
      <circle cx="15" cy="17" r="1" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5" />
      <path d="M5 14v5h14v-5" />
    </>
  ),
  up: <path d="M6 14l6-6 6 6" />,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5" /></>,
  down: <path d="M6 10l6 6 6-6" />,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  download: (
    <>
      <path d="M12 4v12M7.5 11.5 12 16l4.5-4.5" />
      <path d="M5 14v5h14v-5" />
    </>
  ),
  package: (
    <>
      <path d="M4 8l8-4 8 4v8l-8 4-8-4z" />
      <path d="M4 8l8 4 8-4M12 12v8" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  open: (
    <>
      <path d="M13.5 5.5H18.5V10.5M18.5 5.5 11 13" />
      <path d="M17 13.5V17a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 17V8.5A1.5 1.5 0 0 1 7 7h3.5" />
    </>
  ),
  undo: (
    <>
      <path d="M9 5 5 9l4 4" />
      <path d="M5 9h9.5a5 5 0 0 1 0 10H11" />
    </>
  ),
  redo: (
    <>
      <path d="M15 5l4 4-4 4" />
      <path d="M19 9H9.5a5 5 0 0 0 0 10H13" />
    </>
  ),
  more: (
    <>
      <path d="M6.5 12h.01M12 12h.01M17.5 12h.01" strokeWidth="2.6" />
    </>
  ),
  // A planet with a tilted ring; the back of the ring passes behind the planet.
  universe: (
    <>
      <circle cx="12" cy="12" r="5.5" />
      <path d="M2 12a10 3.6 0 0 0 20 0M2 12a10 3.6 0 0 1 5.54-3.22M16.46 8.78A10 3.6 0 0 1 22 12" transform="rotate(-24 12 12)" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8 12.3l2.7 2.7L16 9.5" />
    </>
  )
};

export function Spinner({ className = "" }: { className?: string }) {
  return <span className={`spinner${className ? ` ${className}` : ""}`} aria-hidden="true" />;
}

export function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
