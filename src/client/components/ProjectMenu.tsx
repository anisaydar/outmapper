import { useEffect, useState, type ReactNode } from "react";
import type { ProjectLibraryApi, ProjectMutationResponse } from "../api/project-client.js";
import type { Locale, MessageKey } from "../locales.js";
import { AuthoringDialog } from "./AuthoringDialog.js";
import { Icon, Spinner } from "./Icon.js";


export function ProjectMenu({ api, locale, t, disabled, onBeforeSwitch, onProject, children }: { api: ProjectLibraryApi; locale: Locale; t: (key: MessageKey) => string; disabled: boolean; onBeforeSwitch: () => Promise<boolean>; onProject: (result: ProjectMutationResponse) => void; children?: ReactNode }) {
  const [recent, setRecent] = useState<Array<{ directory: string; title: string }>>([]);
  const [allRecent, setAllRecent] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void api.recent().then(({ projects }) => { if (active) setRecent(projects); }).catch(() => {});
    return () => { active = false; };
  }, [api]);
  const switchProject = async (operation: () => Promise<ProjectMutationResponse | { cancelled: true }>, source: string) => {
    if (busy || disabled) return;
    setBusy(true);
    setPending(source);
    setError("");
    try {
      if (!await onBeforeSwitch()) return;
      const result = await operation();
      if ("cancelled" in result) return;
      onProject(result);
    } catch (error) { setError(error instanceof Error ? error.message : t("loadError")); }
    finally { setBusy(false); setPending(undefined); }
  };
  const previewCount = window.innerHeight < 640 ? 1 : window.innerHeight < 760 ? 2 : 4;
  const visibleRecent = allRecent ? recent : recent.slice(0, previewCount);
  return <>
    <section className="settings-section settings-section--project" aria-labelledby="settings-project-heading">
      <h2 id="settings-project-heading">{t("project")}</h2>
      <div className="settings-actions">
        <div className="settings-action-group">
          <button type="button" className="popover-action" disabled={disabled || busy} onClick={() => { setNewOpen(true); setError(""); }}><Icon name="plus" /><span>{t("newProject")}</span></button>
          <button type="button" className="popover-action" aria-busy={pending === "open"} disabled={disabled || busy} onClick={() => void switchProject(() => api.open(), "open")}>{pending === "open" ? <Spinner /> : <Icon name="folder" />}<span>{t("openProject")}</span></button>
        </div>
        {children}
      </div>
      {error && !newOpen ? <p className="field-error" role="alert">{error}</p> : null}
    </section>
    <section className="settings-section settings-section--recent" aria-labelledby="settings-recent-heading">
      <h2 id="settings-recent-heading">{t("recentProjects")}</h2>
      <div className="recent-projects">{recent.length ? visibleRecent.map((entry) => <button type="button" className="popover-action recent-project" title={entry.directory} key={entry.directory} aria-busy={pending === entry.directory} disabled={disabled || busy} onClick={() => void switchProject(() => api.open(entry.directory), entry.directory)}>{pending === entry.directory ? <Spinner /> : null}<span dir="auto">{entry.title}</span></button>) : <p>{t("noRecentProjects")}</p>}</div>
      {recent.length > previewCount ? <button type="button" className="text-action recent-toggle" aria-expanded={allRecent} onClick={() => setAllRecent((value) => !value)}>{allRecent ? t("showFewerRecent") : `${t("showAllRecent")} (${new Intl.NumberFormat(locale).format(recent.length)})`}</button> : null}
    </section>
    {newOpen ? <AuthoringDialog title={t("newProject")} onClose={() => { if (!busy) setNewOpen(false); }}>
      <form onSubmit={(event) => { event.preventDefault(); if (title.trim()) void switchProject(() => api.create(title.trim(), locale), "create"); }}>
        <label className="field"><span>{t("projectTitle")}</span><input autoFocus required value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} dir="auto" /></label>
        {error ? <p className="field-error" role="alert">{error}</p> : null}
        <div className="dialog-actions"><button type="button" className="pill" disabled={busy} onClick={() => setNewOpen(false)}>{t("cancel")}</button><button type="submit" className="pill pill--accent" aria-busy={busy} disabled={busy || !title.trim()}>{busy ? <Spinner /> : null}{busy ? t("saving") : t("createProject")}</button></div>
      </form>
    </AuthoringDialog> : null}
  </>;
}
