import { useEffect, useMemo, useRef, useState } from "react";
import type { FolderFileKind, FolderImportJob, FolderImportPlan } from "../../domain/folder-import.js";
import type { CanonicalProject } from "../../domain/types.js";
import type { FolderImportApi, ProjectMutationResponse } from "../api/project-client.js";
import type { Locale, MessageKey } from "../locales.js";
import { AuthoringDialog } from "./AuthoringDialog.js";
import { FilePicker } from "./FilePicker.js";
import { Icon, Spinner } from "./Icon.js";

interface FolderImportDialogProps {
  project: CanonicalProject;
  target?: { kind: "topic" | "keyIssue"; id: string };
  api: FolderImportApi;
  locale: Locale;
  t: (key: MessageKey) => string;
  onClose: () => void;
  onMutation: (result: ProjectMutationResponse) => void;
  onBusyChange: (busy: boolean) => void;
}

export function FolderImportDialog({ project, target, api, locale, t, onClose, onMutation, onBusyChange }: FolderImportDialogProps) {
  const [plan, setPlan] = useState<FolderImportPlan>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [subfolders, setSubfolders] = useState(true);
  const [kinds, setKinds] = useState<Set<FolderFileKind>>(() => new Set(["pdf", "note", "link", "attachment"]));
  const [destination, setDestination] = useState(target ? `${target.kind}:${target.id}` : project.topics[0] ? `topic:${project.topics[0].id}` : "");
  const [duplicates, setDuplicates] = useState<"skip" | "keep">("skip");
  const [job, setJob] = useState<FolderImportJob>();
  const [selecting, setSelecting] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const selection = useRef<AbortController | undefined>(undefined);
  const visible = useMemo(() => (plan?.files ?? []).filter((file) => (subfolders || !file.path.includes("/")) && (!file.kind || kinds.has(file.kind))), [kinds, plan?.files, subfolders]);
  const selectedFiles = visible.filter((file) => selected.has(file.id) && !file.error);
  const running = job?.status === "running";
  const jobId = job?.id;
  const jobStatus = job?.status;

  useEffect(() => () => selection.current?.abort(), []);

  useEffect(() => {
    if (!jobId || jobStatus !== "running") return;
    let active = true;
    let timer: number;
    const poll = async () => {
      try {
        const result = await api.status(jobId);
        if (!active) return;
        setJob(result.job);
        setError("");
        if (result.job.status === "running") timer = window.setTimeout(() => void poll(), 400);
        else {
          onBusyChange(false);
          if (result.project && result.history) onMutation({ project: result.project, history: result.history });
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : t("transferError"));
      }
    };
    timer = window.setTimeout(() => void poll(), 100);
    return () => { active = false; window.clearTimeout(timer); };
  }, [api, jobId, jobStatus, onBusyChange, onMutation, retry, t]);

  const chooseFolder = async () => {
    if (selecting || running) return;
    const controller = new AbortController();
    selection.current = controller;
    setSelecting(true);
    setError("");
    onBusyChange(true);
    try {
      const result = await api.preview(controller.signal);
      if (controller.signal.aborted || "cancelled" in result) return;
      setPlan(result);
      setSelected(new Set(result.files.filter((file) => !file.error).map(({ id }) => id)));
    } catch (caught) {
      if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : t("transferError"));
    } finally {
      if (selection.current === controller) selection.current = undefined;
      setSelecting(false);
      onBusyChange(false);
    }
  };

  const cancel = async () => {
    if (selecting || starting) return;
    setError("");
    try {
      if (running && job) {
        setCancelling(true);
        await api.cancel(job.id);
        setRetry((value) => value + 1);
      } else {
        if (plan && !job) await api.discard(plan.id);
        onClose();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("transferError"));
      setCancelling(false);
    }
  };

  const start = async () => {
    if (!plan || starting || !selectedFiles.length || !destination) return;
    setStarting(true);
    setError("");
    onBusyChange(true);
    const separator = destination.indexOf(":");
    try {
      setJob(await api.start(plan.id, {
        fileIds: selectedFiles.map(({ id }) => id),
        duplicates,
        target: { kind: destination.slice(0, separator) as "topic" | "keyIssue", id: destination.slice(separator + 1) }
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("transferError"));
      onBusyChange(false);
    } finally {
      setStarting(false);
    }
  };

  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const outcome = !job || job.status === "running" ? undefined : job.status === "completed" ? job.failures.length ? "warning" : "success" : job.status === "cancelled" ? "neutral" : "error";
  const percent = (value: number, total: number) => new Intl.NumberFormat(locale, { style: "percent" }).format(total ? value / total : 0);
  const title = job
    ? running ? "importingFiles" : job.status === "completed" ? "importCompleted" : job.status === "cancelled" ? "importCancelled" : "importFailed"
    : "importFolder";

  return <AuthoringDialog title={t(title)} wide onClose={() => void cancel()}>
    {!plan && !job ? <div className="folder-import-entry">
      <p>{t("importFolderIntro")}</p>
      <FilePicker icon="folder" label={t("chooseImportFolder")} busyLabel={t("selectingFolder")} hint={t("importFolderTypes")} busy={selecting} onChoose={() => void chooseFolder()} />
    </div> : !job && plan ? <>
      <p className="folder-path" dir="auto">{plan.folder}</p>
      <label className="field"><span>{t("destination")}</span><select value={destination} disabled={starting} onChange={(event) => setDestination(event.target.value)}>
        <option value="">{t("destination")}</option>
        {project.topics.map((topic) => <optgroup label={topic.title} key={topic.id}><option value={`topic:${topic.id}`}>{topic.title}</option>{project.keyIssues.filter(({ topicId }) => topicId === topic.id).map((issue) => <option key={issue.id} value={`keyIssue:${issue.id}`}>{issue.title}</option>)}</optgroup>)}
      </select></label>
      <div className="folder-options"><label className="check-field"><input type="checkbox" checked={subfolders} disabled={starting} onChange={(event) => setSubfolders(event.target.checked)} />{t("subfolders")}</label>
        <label className="field"><span>{t("duplicates")}</span><select value={duplicates} disabled={starting} onChange={(event) => setDuplicates(event.target.value as "skip" | "keep")}><option value="skip">{t("skipDuplicates")}</option><option value="keep">{t("keepDuplicates")}</option></select></label>
      </div>
      <fieldset className="folder-types" disabled={starting}><legend>{t("fileTypes")}</legend>{(["pdf", "note", "link", "attachment"] as const).map((kind) => <label className="check-field" key={kind}><input type="checkbox" checked={kinds.has(kind)} onChange={(event) => setKinds((current) => { const next = new Set(current); if (event.target.checked) next.add(kind); else next.delete(kind); return next; })} />{t(kind === "pdf" ? "pdfType" : kind === "note" ? "notes" : kind === "link" ? "linkType" : "attachments")}</label>)}</fieldset>
      <div className="folder-selection"><label className="check-field"><input type="checkbox" disabled={starting || !visible.some((file) => !file.error)} checked={visible.some((file) => !file.error) && visible.filter((file) => !file.error).every(({ id }) => selected.has(id))} onChange={(event) => setSelected((current) => { const next = new Set(current); for (const file of visible.filter((file) => !file.error)) { if (event.target.checked) next.add(file.id); else next.delete(file.id); } return next; })} />{t("selectAll")}</label><span>{number(selectedFiles.length)} {t("selectedFiles")}</span></div>
      <div className="folder-files">{visible.length ? visible.map((file) => <label className={`folder-file${file.error ? " folder-file--excluded" : ""}`} key={file.id}><input type="checkbox" checked={selected.has(file.id)} disabled={starting || Boolean(file.error)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(file.id); else next.delete(file.id); return next; })} /><span><strong dir="auto">{file.path}</strong><small>{file.error ?? `${number(Math.ceil(file.bytes / 1024))} KB${file.duplicate ? ` · ${t("duplicateFile")}` : ""}`}</small></span></label>) : <p>{t("noImportFiles")}</p>}</div>
      <p className="field-hint">{t("importOriginals")}</p>
    </> : job ? <>
      {running ? <div className="import-progress">
        <div className="import-progress__label"><Spinner /><span role="status">{number(job.processed)} / {number(job.total)}</span><b>{percent(job.processed, job.total)}</b></div>
        <progress max={Math.max(1, job.total)} value={job.processed} aria-label={t("importingFiles")} />
        {job.currentFile ? <p className="folder-path" dir="auto">{job.currentFile}</p> : null}
      </div> : <p className="visually-hidden" role="status">{t(title)}</p>}
      <dl className="import-summary"><div data-tone={job.imported && outcome !== "error" ? "success" : undefined}><dt>{t("importedFiles")}</dt><dd>{outcome === "success" ? <Icon name="success" /> : null}{number(job.imported)}</dd></div><div><dt>{t("skippedFiles")}</dt><dd>{number(job.skipped)}</dd></div><div data-tone={job.failures.length ? "danger" : undefined}><dt>{t("failedFiles")}</dt><dd>{job.failures.length ? <Icon name="alert" /> : null}{number(job.failures.length)}</dd></div></dl>
      {job.error ? <p className="field-error" role="alert">{job.error}</p> : null}
      {job.failures.length ? <ul className="folder-failures">{job.failures.map((failure) => <li key={failure.path}><b dir="auto">{failure.path}</b><span>{failure.error}</span></li>)}</ul> : null}
    </> : null}
    {error ? <p className="field-error" role="alert">{error}</p> : null}
    <div className="dialog-actions">
      {error && running ? <button type="button" className="pill" onClick={() => setRetry((value) => value + 1)}>{t("retryStatus")}</button> : null}
      <button type="button" className="pill" disabled={selecting || starting || running && cancelling} onClick={() => void cancel()}>{running && cancelling ? <Spinner /> : null}{t(job ? running ? cancelling ? "cancelRequested" : "cancelImport" : "done" : "cancel")}</button>
      {plan && !job ? <button type="button" className="pill pill--accent" aria-busy={starting} disabled={starting || !destination || !selectedFiles.length} onClick={() => void start()}>{starting ? <Spinner /> : null}{t(starting ? "importingFiles" : "importFiles")}</button> : null}
    </div>
  </AuthoringDialog>;
}
