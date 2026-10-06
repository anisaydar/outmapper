import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { WorkspaceProjectEntry } from "../../domain/workspace.js";
import type { ProjectLibraryApi, ProjectMutationResponse } from "../api/project-client.js";
import type { Locale, MessageKey } from "../locales.js";
import { AuthoringDialog } from "./AuthoringDialog.js";
import { Icon, Spinner } from "./Icon.js";

export function ProjectMenu({ api, locale, t, disabled, onBeforeSwitch, onProject, onWorkspace, onUniverse, children }: {
  api: ProjectLibraryApi;
  locale: Locale;
  t: (key: MessageKey) => string;
  disabled: boolean;
  onBeforeSwitch: () => Promise<boolean>;
  onProject: (result: ProjectMutationResponse, created: boolean) => void;
  onWorkspace?: (projects: WorkspaceProjectEntry[], activeInstanceId: string) => void;
  onUniverse?: () => void;
  children?: ReactNode;
}) {
  const [recent, setRecent] = useState<WorkspaceProjectEntry[]>([]);
  const [activeInstanceId, setActiveInstanceId] = useState<string>();
  const [allRecent, setAllRecent] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string>();
  const [rowMenu, setRowMenu] = useState<string>();
  const [forget, setForget] = useState<WorkspaceProjectEntry>();
  const [error, setError] = useState("");
  const [menuPlacement, setMenuPlacement] = useState<"below" | "above">("below");
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggers = useRef(new Map<string, HTMLButtonElement>());
  const load = useCallback(async (refresh = false) => {
    const data = await (refresh ? api.refresh() : api.workspace());
    const projects = Object.values(data.projects)
      .filter(({ hiddenFromRecent }) => !hiddenFromRecent)
      .sort((left, right) => (right.lastOpenedAt ?? "").localeCompare(left.lastOpenedAt ?? "") || right.lastSeenAt.localeCompare(left.lastSeenAt));
    setRecent(projects);
    setActiveInstanceId(data.activeInstanceId);
    onWorkspace?.(Object.values(data.projects), data.activeInstanceId);
  }, [api, onWorkspace]);
  useEffect(() => {
    const timeout = window.setTimeout(() => { void load().catch(() => undefined); }, 0);
    return () => window.clearTimeout(timeout);
  }, [load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(true).catch(() => undefined); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  const switchProject = async (operation: () => Promise<ProjectMutationResponse | { cancelled: true }>, source: string) => {
    if (busy || disabled) return;
    setBusy(true);
    setPending(source);
    setError("");
    try {
      if (!await onBeforeSwitch()) return;
      const result = await operation();
      if ("cancelled" in result) return;
      if (source === "create") {
        setNewOpen(false);
        setTitle("");
      }
      onProject(result, source === "create");
      await load();
    } catch (problem) { setError(problem instanceof Error ? problem.message : t("loadError")); }
    finally { setBusy(false); setPending(undefined); }
  };
  const previewCount = window.innerHeight < 640 ? 1 : window.innerHeight < 760 ? 2 : 4;
  const visibleRecent = allRecent ? recent : recent.slice(0, previewCount);
  const titleCounts = new Map<string, number>();
  for (const entry of recent) titleCounts.set(entry.title, (titleCounts.get(entry.title) ?? 0) + 1);
  // Copies of one Project share a single quiet Duplicate badge, on the first copy that is not the current Project.
  const duplicateBadgeIds = new Set<string>();
  const badgedProjects = new Set<string>();
  for (const entry of recent) {
    if (entry.status !== "duplicate" || entry.instanceId === activeInstanceId || badgedProjects.has(entry.projectId)) continue;
    badgedProjects.add(entry.projectId);
    duplicateBadgeIds.add(entry.instanceId);
  }
  const folderHint = (directory: string) => directory.split(/[\\/]/u).filter(Boolean).at(-1) ?? directory;
  const statusLabel = (entry: WorkspaceProjectEntry): string | undefined => {
    if (entry.status === "duplicate") return duplicateBadgeIds.has(entry.instanceId) ? t("projectDuplicate") : undefined;
    return {
      available: undefined,
      missing: t("projectMissing"),
      mismatch: t("projectFolderChanged"),
      unreadable: t("projectUnavailable"),
      "needs-open": t("projectNeedsOpen")
    }[entry.status];
  };
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setRowMenu((open) => {
      if (open && restoreFocus) window.setTimeout(() => menuTriggers.current.get(open)?.focus(), 0);
      return undefined;
    });
  }, []);
  // The row menu closes on any outside press, including elsewhere inside Settings.
  useEffect(() => {
    if (!rowMenu) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || menuTriggers.current.get(rowMenu)?.contains(target)) return;
      closeMenu(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [closeMenu, rowMenu]);
  // Open below the trigger unless the Settings scroll area would clip it, then focus the first item.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!rowMenu || !menu) return;
    const limit = Math.min(menu.closest(".settings-popover")?.getBoundingClientRect().bottom ?? window.innerHeight, window.innerHeight);
    if (menu.getBoundingClientRect().bottom > limit - 8) setMenuPlacement("above");
    menu.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
    return () => setMenuPlacement("below");
  }, [rowMenu]);
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      closeMenu(false);
    }
  };
  const hide = async (entry: WorkspaceProjectEntry) => {
    await api.removeFromRecent(entry.instanceId);
    setRowMenu(undefined);
    await load();
  };
  const locate = async (entry: WorkspaceProjectEntry) => {
    closeMenu(true);
    setPending(entry.instanceId);
    setError("");
    try {
      const result = await api.locate(entry.instanceId);
      if (!("cancelled" in result)) await load(true);
    } catch (problem) { setError(problem instanceof Error ? problem.message : t("loadError")); }
    finally { setPending(undefined); }
  };
  const forgetProject = async () => {
    if (!forget) return;
    setBusy(true);
    try { await api.forget(forget.instanceId); setForget(undefined); await load(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : t("loadError")); }
    finally { setBusy(false); }
  };
  return <>
    <section className="settings-section settings-section--project" aria-labelledby="settings-project-heading">
      <h2 id="settings-project-heading">{t("projects")}</h2>
      <div className="settings-actions"><div className="settings-action-group">
        {onUniverse ? <button type="button" className="popover-action" disabled={disabled || busy} onClick={onUniverse}><Icon name="map" /><span>{t("universe")}</span></button> : null}
        <button type="button" className="popover-action" disabled={disabled || busy} onClick={() => { setNewOpen(true); setError(""); }}><Icon name="plus" /><span>{t("newProject")}</span></button>
        <button type="button" className="popover-action" aria-busy={pending === "open"} disabled={disabled || busy} onClick={() => void switchProject(() => api.open(), "open")}>{pending === "open" ? <Spinner /> : <Icon name="folder" />}<span>{t("openProject")}</span></button>
        {children}
      </div></div>
      {error && !newOpen ? <p className="field-error" role="alert">{error}</p> : null}
    </section>
    <section className="settings-section settings-section--recent" aria-labelledby="settings-recent-heading">
      <h2 id="settings-recent-heading">{t("recentProjects")}</h2>
      <div className="recent-projects">{recent.length ? visibleRecent.map((entry) => {
        const current = entry.instanceId === activeInstanceId;
        const unavailable = entry.status === "missing" || entry.status === "mismatch" || entry.status === "unreadable";
        const status = statusLabel(entry);
        const menuOpen = rowMenu === entry.instanceId;
        const label = <>
          <span className="recent-project__copy">
            <span dir="auto">{entry.title}</span>
            {(titleCounts.get(entry.title) ?? 0) > 1 ? <small dir="auto">{folderHint(entry.directory)}</small> : null}
          </span>
          {status ? <small className="status-badge">{status}</small> : null}
          {pending === entry.instanceId ? <Spinner /> : null}
        </>;
        return <div className={`recent-project-row${unavailable ? " recent-project-row--unavailable" : ""}`} key={entry.instanceId} onKeyDown={(event) => {
          if (event.key !== "Escape" || !menuOpen) return;
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
        }}>
          {current
            ? <div className="popover-action recent-project recent-project--current" title={entry.directory} aria-current="true">{label}<span className="visually-hidden">{t("currentProject")}</span></div>
            : unavailable
              ? <div className="popover-action recent-project recent-project--unavailable" title={entry.directory}>{label}</div>
              : <button type="button" className="popover-action recent-project" title={entry.directory} aria-busy={pending === entry.instanceId} disabled={disabled || busy} onClick={() => void switchProject(() => api.activate(entry.instanceId), entry.instanceId)}>{label}</button>}
          {current
            ? <span className="recent-project__check" aria-hidden="true"><Icon name="check" /></span>
            : <button ref={(element) => { if (element) menuTriggers.current.set(entry.instanceId, element); else menuTriggers.current.delete(entry.instanceId); }} type="button" className="recent-project__menu" aria-label={`${t("projectActions")}: ${entry.title}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setRowMenu((value) => value === entry.instanceId ? undefined : entry.instanceId)}><Icon name="more" /></button>}
          {menuOpen ? <div ref={menuRef} className="recent-project-menu" role="menu" aria-label={`${t("projectActions")}: ${entry.title}`} data-placement={menuPlacement} onKeyDown={menuKeyDown}>
            {unavailable ? <button type="button" role="menuitem" tabIndex={-1} disabled={disabled || busy} onClick={() => void locate(entry)}>{t("locate")}</button> : null}
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => void hide(entry)}>{t("removeFromRecent")}</button>
            <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setForget(entry); setRowMenu(undefined); }}>{t("forgetProject")}</button>
          </div> : null}
        </div>;
      }) : <p>{t("noRecentProjects")}</p>}</div>
      {recent.length > previewCount ? <button type="button" className="text-action recent-toggle" aria-expanded={allRecent} onClick={() => setAllRecent((value) => !value)}>{allRecent ? t("showFewerRecent") : `${t("showAllRecent")} (${new Intl.NumberFormat(locale).format(recent.length)})`}</button> : null}
    </section>
    {newOpen ? <AuthoringDialog title={t("newProject")} onClose={() => { if (!busy) setNewOpen(false); }}><form onSubmit={(event) => { event.preventDefault(); if (title.trim()) void switchProject(() => api.create(title.trim(), locale), "create"); }}><label className="field"><span>{t("projectTitle")}</span><input autoFocus required value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>{error ? <p className="field-error" role="alert">{error}</p> : null}<div className="dialog-actions"><button type="button" className="pill" disabled={busy} onClick={() => setNewOpen(false)}>{t("cancel")}</button><button type="submit" className="pill pill--accent" aria-busy={busy} disabled={busy || !title.trim()}>{busy ? <Spinner /> : null}{busy ? t("saving") : t("createProject")}</button></div></form></AuthoringDialog> : null}
    {forget ? <AuthoringDialog title={t("forgetProject")} onClose={() => { if (!busy) setForget(undefined); }}><p>{t("forgetProjectBody")}</p><div className="dialog-actions"><button type="button" className="pill" disabled={busy} onClick={() => setForget(undefined)}>{t("cancel")}</button><button type="button" className="pill pill--danger" aria-busy={busy} disabled={busy} onClick={() => void forgetProject()}>{busy ? <Spinner /> : null}{t("forgetProject")}</button></div></AuthoringDialog> : null}
  </>;
}
