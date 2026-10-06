import { useEffect, useMemo, useState } from "react";
import type { Topic } from "../../domain/types.js";
import type { WorkspaceProjectEntry } from "../../domain/workspace.js";
import type { MessageKey } from "../locales.js";
import { AuthoringDialog } from "./AuthoringDialog.js";
import { Spinner } from "./Icon.js";

export interface ProjectLinkSelection {
  targetProjectId: string;
  targetTopicId?: string;
  cachedProjectTitle: string;
  cachedTopicTitle?: string;
  note?: string;
}

export function ProjectLinkDialog({ currentProjectId, projects, t, loadTopics, onSubmit, onClose }: {
  currentProjectId: string;
  projects: WorkspaceProjectEntry[];
  t: (key: MessageKey) => string;
  loadTopics: (instanceId: string) => Promise<{ homeTopicId?: string; topics: Topic[] }>;
  onSubmit: (selection: ProjectLinkSelection) => Promise<void>;
  onClose: () => void;
}) {
  const choices = useMemo(() => {
    const byProject = new Map<string, WorkspaceProjectEntry>();
    for (const project of projects) {
      if (project.projectId === currentProjectId || (project.status !== "available" && project.status !== "duplicate")) continue;
      const previous = byProject.get(project.projectId);
      if (!previous || (project.lastOpenedAt ?? "") > (previous.lastOpenedAt ?? "")) byProject.set(project.projectId, project);
    }
    return [...byProject.values()].sort((left, right) => left.title.localeCompare(right.title));
  }, [currentProjectId, projects]);
  const [instanceId, setInstanceId] = useState(choices[0]?.instanceId ?? "");
  const [topics, setTopics] = useState<Topic[]>([]);
  const [homeTopicId, setHomeTopicId] = useState<string>();
  const [topicId, setTopicId] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingTopics, setLoadingTopics] = useState(Boolean(choices[0]));
  const [error, setError] = useState("");
  useEffect(() => {
    if (!instanceId) return;
    let active = true;
    void loadTopics(instanceId).then((result) => {
      if (!active) return;
      setTopics(result.topics);
      setHomeTopicId(result.homeTopicId);
    }).catch((problem: unknown) => { if (active) setError(problem instanceof Error ? problem.message : t("projectUnavailable")); })
      .finally(() => { if (active) setLoadingTopics(false); });
    return () => { active = false; };
  }, [instanceId, loadTopics, t]);
  const selectedProject = choices.find((project) => project.instanceId === instanceId);
  const selectedTopic = topics.find((topic) => topic.id === topicId);
  return <AuthoringDialog title={t("linkAnotherProject")} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (!selectedProject || busy) return;
      setBusy(true);
      setError("");
      void onSubmit({
        targetProjectId: selectedProject.projectId,
        ...(selectedTopic ? { targetTopicId: selectedTopic.id, cachedTopicTitle: selectedTopic.title } : {}),
        cachedProjectTitle: selectedProject.title,
        ...(note.trim() ? { note: note.trim() } : {})
      }).then(onClose).catch((problem: unknown) => setError(problem instanceof Error ? problem.message : t("saveError"))).finally(() => setBusy(false));
    }}>
      <label className="field"><span>{t("selectProject")}</span><select autoFocus required value={instanceId} disabled={busy} onChange={(event) => { setInstanceId(event.target.value); setTopicId(""); setTopics([]); setLoadingTopics(true); setError(""); }}>{choices.map((project) => <option value={project.instanceId} key={project.instanceId}>{project.title}</option>)}</select></label>
      <label className="field"><span className="field__label">{t("selectTopic")}{loadingTopics ? <Spinner /> : null}</span><select value={topicId} disabled={busy || loadingTopics} aria-busy={loadingTopics} onChange={(event) => setTopicId(event.target.value)}><option value="">{t("homeTopicDefault")}</option>{topics.filter(({ id }) => id !== homeTopicId).map((topic) => <option value={topic.id} key={topic.id}>{topic.title}</option>)}</select></label>
      <label className="field"><span>{t("optionalNote")}</span><textarea rows={3} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} /></label>
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" className="pill" disabled={busy} onClick={onClose}>{t("cancel")}</button><button type="submit" className="pill pill--accent" aria-busy={busy} disabled={busy || !selectedProject}>{busy ? <Spinner /> : null}{t("add")}</button></div>
    </form>
  </AuthoringDialog>;
}
