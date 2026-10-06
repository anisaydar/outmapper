import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KnowledgeContextTarget } from "../../domain/knowledge-query.js";
import type { CanonicalProject, KnowledgeItem } from "../../domain/types.js";
import type { GraphProjection } from "../../graph/projection.js";
import type { HistoryState } from "../api/project-client.js";
import type { MessageKey } from "../locales.js";
import { useEntityDraft, type DraftAck } from "../use-entity-draft.js";
import { AuthoringDialog } from "./AuthoringDialog.js";
import { closeOnBackdropPress } from "./dialog-backdrop.js";
import { FilePicker } from "./FilePicker.js";
import { ReorderList, type ReorderItem } from "./ReorderList.js";
import { Icon, Spinner } from "./Icon.js";
import { TopicCombobox } from "./TopicCombobox.js";

export type StudioText = { title: string; description: string };

export interface StudioCover {
  url?: string;
  /** The entity has its own cover asset. */
  own: boolean;
  /** A Key Issue without its own cover shows its Topic's cover. */
  inherited: boolean;
}

interface StudioPanelProps {
  project: CanonicalProject;
  displayTopics?: CanonicalProject["topics"];
  projection: GraphProjection;
  target: KnowledgeContextTarget;
  t: (key: MessageKey) => string;
  locale?: string;
  saveState: "saved" | "saving" | "error";
  history: HistoryState;
  resyncToken: number;
  cover: StudioCover;
  isHomeTopic: boolean;
  focusTitle?: boolean;
  onSave: (patch: Partial<StudioText>) => Promise<DraftAck<StudioText>>;
  onFlushReady?: (flush: (() => Promise<boolean>) | undefined) => void;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onClose: () => void;
  hasSessionChanges: () => boolean;
  onDiscard: () => Promise<void>;
  onNewTopic: () => Promise<void>;
  onSetHomeTopic: () => Promise<void>;
  onSetCover: (file: File, onProgress: (fraction: number) => void) => Promise<void>;
  onRemoveCover: () => Promise<void>;
  onImportFolder: () => void;
  onDelete: () => Promise<void>;
  onAddKeyIssue: (title: string) => Promise<void>;
  onReorderKeyIssues: (ids: string[]) => Promise<void>;
  onAddRelationship: (targetTopicId: string) => Promise<void>;
  onCreateRelationshipTopic: (title: string) => Promise<void>;
  onRemoveRelationship: (relationshipId: string) => Promise<void>;
  onRemoveProjectLink: (projectLinkId: string) => Promise<void>;
  onReorderTargets: (ids: string[]) => Promise<void>;
  onOpenProjectLink: () => void;
  onAddKnowledge: (input: Pick<KnowledgeItem, "title" | "body" | "type" | "availability" | "externalUrl">) => Promise<void>;
  onAttachAsset: (file: File, onProgress: (fraction: number) => void) => Promise<void>;
  /** Called once after a batch of attachments finishes, for a single summary notice. */
  onAttachComplete: (summary: { files: File[]; attached: number; failed: number }) => void;
}

interface UploadEntry {
  key: string;
  name: string;
  status: "queued" | "uploading" | "done" | "error";
  progress?: number;
  error?: string;
}

const KNOWLEDGE_TYPES: Array<[string, MessageKey]> = [
  ["note", "noteType"],
  ["article", "articleType"],
  ["research-paper", "researchPaperType"],
  ["video", "videoType"],
  ["dataset", "datasetType"],
  ["web-link", "linkType"]
];
const COVER_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

/** True only after `active` has stayed true for `delay` ms, so quick saves never flash a busy state. */
function useDelayedFlag(active: boolean, delay: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setElapsed(active), active ? delay : 0);
    return () => window.clearTimeout(timer);
  }, [active, delay]);
  return active && elapsed;
}

/**
 * Sizes a textarea to its content; CSS min-height and max-height bound it, and past the maximum it scrolls. The
 * panel's scroll position is kept while measuring, and a focused field that grows stays visible.
 */
function fitTextarea(element: HTMLTextAreaElement) {
  const scroller = element.closest<HTMLElement>(".knowledge-panel");
  const scrollTop = scroller?.scrollTop ?? 0;
  const previous = element.offsetHeight;
  element.style.height = "auto";
  const border = element.offsetHeight - element.clientHeight;
  element.style.height = `${element.scrollHeight + border}px`;
  if (!scroller) return;
  scroller.scrollTop = scrollTop;
  const grew = element.offsetHeight - previous;
  if (grew <= 0 || document.activeElement !== element) return;
  const hidden = element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom;
  if (hidden > 0) scroller.scrollTop += Math.min(hidden, grew);
}

function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (ref.current) fitTextarea(ref.current);
  }, [value]);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver !== "function") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fitTextarea(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/**
 * True for `duration` ms after the Project reaches a new saved revision, so the bar can briefly confirm the save. The
 * revision is the trigger because a fast save can go from saving to saved without an intermediate render.
 */
function useSavedFlash(revision: number, duration: number): boolean {
  const [flash, setFlash] = useState(false);
  const previous = useRef(revision);
  useEffect(() => {
    if (previous.current === revision) return;
    previous.current = revision;
    const show = window.setTimeout(() => setFlash(true), 0);
    const hide = window.setTimeout(() => setFlash(false), duration);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [revision, duration]);
  return flash;
}

export function StudioPanel({
  project,
  displayTopics = project.topics,
  projection,
  target,
  t,
  locale,
  saveState,
  history,
  resyncToken,
  cover,
  isHomeTopic,
  focusTitle = false,
  onSave,
  onFlushReady,
  onUndo,
  onRedo,
  onClose,
  hasSessionChanges,
  onDiscard,
  onNewTopic,
  onSetHomeTopic,
  onSetCover,
  onRemoveCover,
  onImportFolder,
  onDelete,
  onAddKeyIssue,
  onReorderKeyIssues,
  onAddRelationship,
  onCreateRelationshipTopic,
  onRemoveRelationship,
  onRemoveProjectLink,
  onReorderTargets,
  onOpenProjectLink,
  onAddKnowledge,
  onAttachAsset,
  onAttachComplete
}: StudioPanelProps) {
  const entity =
    target.kind === "topic"
      ? project.topics.find(({ id }) => id === target.id)
      : project.keyIssues.find(({ id }) => id === target.id);
  const draft = useEntityDraft<StudioText>({
    values: { title: entity?.title ?? "", description: entity?.description ?? "" },
    revision: project.manifest.revision,
    resyncToken,
    save: onSave,
    canSave: (field, value) => field !== "title" || value.trim().length > 0
  });
  const title = draft.values.title;
  const flushDraft = draft.flush;
  useEffect(() => {
    onFlushReady?.(flushDraft);
    return () => onFlushReady?.(undefined);
  }, [flushDraft, onFlushReady]);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [addingIssue, setAddingIssue] = useState(false);
  const [relationshipBusy, setRelationshipBusy] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeBody, setKnowledgeBody] = useState("");
  const [knowledgeType, setKnowledgeType] = useState("note");
  const [knowledgeUrl, setKnowledgeUrl] = useState("");
  const [knowledgeUrlChecked, setKnowledgeUrlChecked] = useState(false);
  const [addingKnowledge, setAddingKnowledge] = useState(false);
  const [knowledgeAddError, setKnowledgeAddError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [uploads, setUploads] = useState<UploadEntry[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [coverOpen, setCoverOpen] = useState(false);
  const [coverBusy, setCoverBusy] = useState(false);
  const [coverProgress, setCoverProgress] = useState<number>();
  const [coverError, setCoverError] = useState("");
  const [closing, setClosing] = useState(false);
  const [creatingTopic, setCreatingTopic] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "discard">();
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const titleInput = useRef<HTMLInputElement | null>(null);
  const confirmDialog = useRef<HTMLDialogElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const fieldId = useId();
  const knowledgeFormId = useId();
  const knowledgeUrlInput = useRef<HTMLInputElement>(null);
  const knowledgeTitleInput = useRef<HTMLInputElement>(null);
  const knowledgeSubmission = useRef(false);
  const externalKnowledge = knowledgeType !== "note";
  const validKnowledgeUrl = (() => {
    if (!/^https?:\/\//i.test(knowledgeUrl.trim())) return false;
    try {
      const url = new URL(knowledgeUrl.trim());
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  })();
  const knowledgeUrlError = externalKnowledge && knowledgeUrlChecked && !validKnowledgeUrl;
  const deleteLabel = t(target.kind === "topic" ? "deleteTopic" : "deleteKeyIssue");
  const slowSave = useDelayedFlag(saveState === "saving", 400);
  const saveFailed = saveState === "error" || draft.error;
  const savedFlash = useSavedFlash(project.manifest.revision, 1800);
  const saveText = saveFailed ? t("saveError") : slowSave ? t("saving") : t("allChangesSaved");
  const saveTone = saveFailed ? "error" : slowSave ? "saving" : savedFlash ? "flash" : "idle";
  const titleField = draft.field("title");
  const descriptionField = draft.field("description");
  const descriptionInputRef = useAutoGrow(descriptionField.value);

  useEffect(() => {
    if (!announcement) return;
    const timer = window.setTimeout(() => setAnnouncement(""), 5000);
    return () => window.clearTimeout(timer);
  }, [announcement]);

  const reorder = (save: (ids: string[]) => Promise<void>, count: number) => (ids: string[], moved: ReorderItem, position: number) => {
    const number = new Intl.NumberFormat(locale);
    setAnnouncement(t("movedToPosition").replace("{title}", moved.title).replace("{position}", number.format(position + 1)).replace("{count}", number.format(count)));
    // ReorderList shows the new order immediately and rolls it back if this save fails; runMutation reports it.
    return save(ids);
  };

  useEffect(() => {
    if (!focusTitle) return;
    titleInput.current?.focus();
    titleInput.current?.select();
  }, [focusTitle]);

  /** Saves pending text first; false keeps Studio open with the title focused when it cannot be saved. */
  const settle = async () => {
    if (await draft.flush()) return true;
    if (!title.trim()) titleInput.current?.focus();
    return false;
  };

  const addKnowledge = async () => {
    if (!knowledgeTitle.trim() || knowledgeSubmission.current || closing) return;
    setKnowledgeAddError(false);
    if (externalKnowledge && !validKnowledgeUrl) {
      setKnowledgeUrlChecked(true);
      knowledgeUrlInput.current?.focus();
      return;
    }
    knowledgeSubmission.current = true;
    setAddingKnowledge(true);
    try {
      await onAddKnowledge({
        title: knowledgeTitle.trim(),
        body: knowledgeBody,
        type: knowledgeType,
        availability: externalKnowledge ? "external" : "local",
        ...(externalKnowledge ? { externalUrl: knowledgeUrl.trim() } : {})
      });
      setKnowledgeTitle("");
      setKnowledgeBody("");
      setKnowledgeUrl("");
      setKnowledgeUrlChecked(false);
    } catch {
      setKnowledgeAddError(true);
    } finally {
      knowledgeSubmission.current = false;
      setAddingKnowledge(false);
    }
  };

  const done = async () => {
    if (closing) return;
    setClosing(true);
    if (await settle()) onClose();
    else setClosing(false);
  };

  const cancel = async () => {
    if (closing) return;
    setClosing(true);
    await draft.flush();
    if (!draft.isDirty() && !hasSessionChanges()) {
      onClose();
      return;
    }
    setClosing(false);
    setConfirmError("");
    setConfirm("discard");
  };

  const undoRedo = async (redo: boolean) => {
    await draft.flush();
    await (redo ? onRedo() : onUndo());
  };

  useEffect(() => {
    if (!confirm) return;
    const dialog = confirmDialog.current;
    const trigger = confirm === "delete" ? deleteButton.current : closeButton.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    cancelButton.current?.focus();
    return () => {
      if (typeof dialog.close === "function") dialog.close();
      if (trigger?.isConnected) trigger.focus();
    };
  }, [confirm]);

  /** Uploads files one at a time; a failure is shown on its own row and does not stop the rest. */
  const attachFiles = async (files: File[]) => {
    if (uploading || !files.length) return;
    const batch = Date.now();
    const entries: UploadEntry[] = files.map((file, index) => ({ key: `${batch}:${index}`, name: file.name, status: "queued" }));
    const update = (key: string, patch: Partial<UploadEntry>) => setUploads((current) => current.map((entry) => entry.key === key ? { ...entry, ...patch } : entry));
    setUploads(entries);
    setUploading(true);
    let attached = 0;
    for (const [index, file] of files.entries()) {
      const key = entries[index]!.key;
      setUploadProgress(undefined);
      update(key, { status: "uploading" });
      try {
        await onAttachAsset(file, (fraction) => {
          setUploadProgress(fraction);
          update(key, { progress: fraction });
        });
        attached += 1;
        update(key, { status: "done", progress: 1 });
      } catch (error) {
        update(key, { status: "error", error: error instanceof Error && error.message ? error.message : t("saveError") });
      }
    }
    setUploading(false);
    onAttachComplete({ files, attached, failed: files.length - attached });
  };

  const uploadCover = async (file: File) => {
    if (coverBusy) return;
    if (file.type && !COVER_TYPES.has(file.type)) {
      setCoverError(t("coverTypeError"));
      return;
    }
    setCoverBusy(true);
    setCoverProgress(undefined);
    setCoverError("");
    try {
      await onSetCover(file, setCoverProgress);
      setCoverOpen(false);
    } catch (error) {
      setCoverError(error instanceof Error && error.message ? error.message : t("saveError"));
    } finally {
      setCoverBusy(false);
    }
  };

  const removeCover = async () => {
    if (coverBusy) return;
    setCoverBusy(true);
    try { await onRemoveCover(); } catch { /* runMutation reports the failure */ }
    finally { setCoverBusy(false); }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase("en-US") !== "z") return;
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      ) return;
      if (event.shiftKey ? history.canRedo : history.canUndo) {
        event.preventDefault();
        void flushDraft().then(() => (event.shiftKey ? onRedo() : onUndo())).catch(() => undefined);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [flushDraft, history.canRedo, history.canUndo, onRedo, onUndo]);

  const issueRelationships = useMemo(
    () =>
      target.kind === "keyIssue"
        ? project.relationships
            .filter(({ keyIssueId }) => keyIssueId === target.id)
            .sort(
              (left, right) =>
                (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
                left.id.localeCompare(right.id)
            )
        : [],
    [project.relationships, target]
  );
  const issueProjectLinks = useMemo(
    () => target.kind === "keyIssue"
      ? project.projectLinks.filter(({ keyIssueId }) => keyIssueId === target.id).sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id))
      : [],
    [project.projectLinks, target]
  );
  const topicTitle = (topicId: string) =>
    displayTopics.find(({ id }) => id === topicId)?.title ?? project.topics.find(({ id }) => id === topicId)?.title ?? topicId;
  const relatedIds = new Set(issueRelationships.map(({ targetTopicId }) => targetTopicId));
  const issueTargets = [...issueRelationships.map((relationship) => ({ id: relationship.id, title: topicTitle(relationship.targetTopicId), order: relationship.order, kind: "relationship" as const })),
    ...issueProjectLinks.map((link) => ({ id: link.id, title: link.cachedTopicTitle ? `${link.cachedProjectTitle} · ${link.cachedTopicTitle}` : link.cachedProjectTitle, order: link.order, kind: "project" as const }))]
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id));
  const relationshipCandidates = displayTopics
    .filter(({ id }) => id !== projection.centralTopic.id && !relatedIds.has(id))
    .map(({ id, title: candidateTitle }) => ({ id, title: candidateTitle }));
  const displayTitle = target.kind === "topic"
    ? projection.centralTopic.title
    : projection.keyIssues.find(({ id }) => id === target.id)?.title ?? entity?.title;
  const linkRelationship = async (operation: () => Promise<void>) => {
    setRelationshipBusy(true);
    try { await operation(); } catch { /* runMutation reports the failure */ }
    finally { setRelationshipBusy(false); }
  };

  return (
    <div className="studio-panel">
      <div className="studio-bar">
        <button ref={closeButton} type="button" className="tool studio-bar__close" aria-label={t("cancelStudio")} data-tooltip={t("cancelStudio")} data-tooltip-side="bottom" data-tooltip-align="start" disabled={closing} onClick={() => void cancel()}>
          <Icon name="close" />
        </button>
        <div className="studio-bar__status">
          <div className="studio-bar__history capsule" role="group">
            <button type="button" className="tool" aria-label={t("undo")} data-tooltip={t("undo")} data-tooltip-side="bottom" aria-keyshortcuts="Control+Z Meta+Z" disabled={!history.canUndo || closing} onClick={() => void undoRedo(false).catch(() => undefined)}><Icon name="undo" /></button>
            <button type="button" className="tool" aria-label={t("redo")} data-tooltip={t("redo")} data-tooltip-side="bottom" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" disabled={!history.canRedo || closing} onClick={() => void undoRedo(true).catch(() => undefined)}><Icon name="redo" /></button>
          </div>
          <span className="save-state-slot">
            <span className={`save-state save-state--${saveTone}`} role="status" data-tooltip={saveText} data-tooltip-side="bottom" data-tooltip-align="start">
              {slowSave && !saveFailed ? <Spinner /> : <Icon name={saveFailed ? "alert" : "check"} />}
              <span className="save-state__label" data-visible={saveTone !== "idle"} aria-hidden="true">{saveFailed || slowSave ? saveText : t("saved")}</span>
              <span className="visually-hidden">{saveFailed || slowSave ? saveText : announcement || t("autosaved")}</span>
            </span>
          </span>
        </div>
        <div className="studio-bar__actions">
          <button type="button" className="pill" aria-busy={creatingTopic} disabled={closing || creatingTopic} onClick={async () => {
            if (!await settle()) return;
            setCreatingTopic(true);
            try { await onNewTopic(); } catch { /* runMutation reports the failure */ }
            finally { setCreatingTopic(false); }
          }}>
            {creatingTopic ? <Spinner /> : <Icon name="plus" />}{t("newTopic")}
          </button>
          <button type="button" className="pill pill--accent" disabled={closing} onClick={() => void done()}>
            <Icon name="check" />{t("done")}
          </button>
        </div>
      </div>
      <div className={`studio-heading${cover.url ? " studio-heading--cover" : ""}`}>
        {cover.url ? <img className="panel-cover" key={cover.url} src={cover.url} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
        <div className="studio-cover-actions">
          {cover.inherited ? <span className="cover-badge" title={t("usingTopicCover")}>{t("topicCoverBadge")}</span> : null}
          {cover.own ? (
            <>
              <button type="button" className="icon-action" aria-label={t("changeCover")} data-tooltip={t("changeCover")} data-tooltip-side="bottom" disabled={coverBusy} onClick={() => { setCoverError(""); setCoverOpen(true); }}><Icon name="edit" /></button>
              <button type="button" className="icon-action icon-action--danger" aria-label={t("removeCover")} data-tooltip={t("removeCover")} data-tooltip-side="bottom" aria-busy={coverBusy} disabled={coverBusy} onClick={() => void removeCover()}>{coverBusy ? <Spinner /> : <Icon name="trash" />}</button>
            </>
          ) : (
            <span className="cover-upload-slot">
              <button type="button" className="cover-upload" aria-label={t(cover.inherited ? "setCustomCover" : "uploadCover")} disabled={coverBusy} onClick={() => { setCoverError(""); setCoverOpen(true); }}>
                <Icon name="upload" /><span className="cover-upload__label" aria-hidden="true">{t(cover.inherited ? "setCustomCover" : "uploadCover")}</span>
              </button>
            </span>
          )}
        </div>
        <div className="studio-heading__copy">
          <p className="eyebrow">{t("studio")}</p>
          <h1 dir="auto">{displayTitle}</h1>
        </div>
      </div>
      <div className="studio-form">
        <div className="studio-fields">
        <div className="studio-field">
          <div className="studio-field__label">
            <label htmlFor={`${fieldId}-title`}>{t("title")}</label>
            {target.kind === "topic" ? (
              isHomeTopic
                ? <span className="home-badge"><Icon name="home" />{t("homeTopic")}</span>
                : <button type="button" className="text-action" onClick={() => void onSetHomeTopic().catch(() => undefined)}>{t("setHomeTopic")}</button>
            ) : null}
          </div>
          <input
            id={`${fieldId}-title`}
            name="title"
            {...titleField}
            ref={(element) => { titleInput.current = element; titleField.ref(element); }}
            aria-invalid={!title.trim()}
            aria-describedby={!title.trim() ? `${fieldId}-title-error` : undefined}
          />
          {!title.trim() ? <small id={`${fieldId}-title-error`} className="field-error">{t("titleRequired")}</small> : null}
        </div>
        <label>
          <span>{t("description")}</span>
          <textarea
            className="studio-description"
            rows={5}
            {...descriptionField}
            ref={(element) => { descriptionInputRef.current = element; descriptionField.ref(element); }}
          />
        </label>
        </div>

        {target.kind === "topic" ? (
          <section className="studio-section">
            <div className="studio-section__header"><h2>{t("keyIssues")}</h2></div>
            <ReorderList
              items={projection.keyIssues.map(({ id, title: issueTitle }) => ({ id, title: issueTitle }))}
              labels={{ moveEarlier: t("moveEarlier"), moveLater: t("moveLater") }}
              onReorder={reorder(onReorderKeyIssues, projection.keyIssues.length)}
            />
            <form
              className="inline-add"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newIssueTitle.trim() || addingIssue) return;
                setAddingIssue(true);
                void onAddKeyIssue(newIssueTitle)
                  .then(() => setNewIssueTitle(""))
                  .catch(() => undefined)
                  .finally(() => setAddingIssue(false));
              }}
            >
              <input aria-label={t("addKeyIssue")} placeholder={t("newKeyIssuePlaceholder")} autoComplete="off" value={newIssueTitle} onChange={(event) => setNewIssueTitle(event.target.value)} />
              <button className="inline-add__action" type="submit" aria-busy={addingIssue} disabled={!newIssueTitle.trim() || addingIssue}>
                {addingIssue ? <Spinner /> : <Icon name="plus" />}<span>{t("add")}</span>
              </button>
            </form>
          </section>
        ) : (
          <section className="studio-section">
            <div className="studio-section__header"><h2>{t("relationships")}</h2></div>
            <ReorderList
              items={issueTargets.map((item) => ({ id: item.id, title: item.title, ...(item.kind === "project" ? { icon: "project" as const } : {}) }))}
              labels={{ moveEarlier: t("moveEarlier"), moveLater: t("moveLater"), remove: t("removeRelationship") }}
              onReorder={reorder(onReorderTargets, issueTargets.length)}
              onRemove={(id) => void (issueProjectLinks.some((link) => link.id === id) ? onRemoveProjectLink(id) : onRemoveRelationship(id)).catch(() => undefined)}
            />
            <TopicCombobox
              label={t("addRelationship")}
              placeholder={t("findTopic")}
              createLabel={t("createAndLinkTopic")}
              createHint={t("createAndLinkHint")}
              topics={relationshipCandidates}
              locale={locale}
              busy={relationshipBusy}
              actions={[{ id: "link-project", label: t("linkAnotherProject"), icon: "open", onActivate: onOpenProjectLink }]}
              onSelect={(topicId) => linkRelationship(() => onAddRelationship(topicId))}
              onCreate={(newTitle) => linkRelationship(() => onCreateRelationshipTopic(newTitle))}
            />
          </section>
        )}

        <section className="studio-section">
          <div className="studio-section__header">
            <h2>{t("knowledge")}</h2>
            <button
              type="button"
              className="pill studio-secondary"
              aria-expanded={knowledgeOpen}
              aria-controls={`${knowledgeFormId}-form`}
              onClick={() => {
                setKnowledgeOpen((open) => !open);
                if (!knowledgeOpen) window.requestAnimationFrame(() => knowledgeTitleInput.current?.focus());
              }}
            >
              <Icon name={knowledgeOpen ? "minus" : "plus"} />{t("addKnowledge")}
            </button>
          </div>
          {knowledgeOpen ? (
            <form
              id={`${knowledgeFormId}-form`}
              className="knowledge-form"
              aria-label={t("addKnowledge")}
              aria-busy={addingKnowledge}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                void addKnowledge();
              }}
            >
              <label>
                <span id={`${knowledgeFormId}-type-label`}>{t("knowledgeType")}</span>
                <select aria-labelledby={`${knowledgeFormId}-type-label`} value={knowledgeType} disabled={addingKnowledge} onChange={(event) => {
                  setKnowledgeType(event.target.value);
                  setKnowledgeUrlChecked(false);
                  setKnowledgeAddError(false);
                }}>
                  {KNOWLEDGE_TYPES.map(([type, key]) => (
                    <option key={type} value={type}>{t(key)}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>{t("knowledgeTitle")}</span>
                <input
                  ref={knowledgeTitleInput}
                  name="knowledgeTitle"
                  required
                  disabled={addingKnowledge}
                  value={knowledgeTitle}
                  onChange={(event) => setKnowledgeTitle(event.target.value)}
                />
              </label>
              {externalKnowledge ? (
                <label>
                  <span id={`${knowledgeFormId}-url-label`}>{t("knowledgeUrl")}</span>
                  <input
                    ref={knowledgeUrlInput}
                    type="url"
                    inputMode="url"
                    dir="ltr"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    disabled={addingKnowledge}
                    placeholder="https://"
                    value={knowledgeUrl}
                    aria-labelledby={`${knowledgeFormId}-url-label`}
                    aria-invalid={knowledgeUrlError}
                    aria-describedby={`${knowledgeFormId}-${knowledgeUrlError ? "error" : "hint"}`}
                    onBlur={() => { if (knowledgeUrl.trim()) setKnowledgeUrlChecked(true); }}
                    onChange={(event) => {
                      setKnowledgeUrl(event.target.value);
                      setKnowledgeUrlChecked(false);
                    }}
                  />
                  {knowledgeUrlError ? (
                    <small id={`${knowledgeFormId}-error`} className="field-error" role="alert">{t("knowledgeUrlInvalid")}</small>
                  ) : (
                    <small id={`${knowledgeFormId}-hint`} className="field-hint">{t("knowledgeUrlHint")}</small>
                  )}
                </label>
              ) : null}
              <label>
                <span>{externalKnowledge ? t("knowledgeDescription") : t("knowledgeBody")}</span>
                <textarea
                  rows={3}
                  disabled={addingKnowledge}
                  value={knowledgeBody}
                  onChange={(event) => setKnowledgeBody(event.target.value)}
                />
              </label>
              {knowledgeAddError ? <p className="field-error" role="alert">{t("knowledgeAddError")}</p> : null}
              <button className="pill" type="submit" aria-busy={addingKnowledge} disabled={!knowledgeTitle.trim() || addingKnowledge || closing}>
                {addingKnowledge ? <Spinner /> : <Icon name="plus" />}
                {addingKnowledge ? t("knowledgeAdding") : externalKnowledge ? t("addKnowledge") : t("addNote")}
              </button>
            </form>
          ) : null}
        </section>
        <section className="studio-section">
          <div className="studio-section__header"><h2>{t("attachments")}</h2></div>
          <FilePicker
            label={t("attachFile")}
            hint={t("dropFiles")}
            busyLabel={t("uploading")}
            busy={uploading}
            progress={uploadProgress}
            locale={locale}
            multiple
            onFiles={(files) => void attachFiles(files)}
          />
          {uploads.length ? (
            <ul className="upload-list" aria-label={t("attachments")}>
              {uploads.map((entry) => (
                <li key={entry.key} data-status={entry.status}>
                  <Icon name={entry.status === "error" ? "alert" : entry.status === "done" ? "success" : "upload"} />
                  <span className="upload-list__name" dir="auto">{entry.name}</span>
                  {entry.status === "error"
                    ? <span className="field-error" role="alert">{entry.error}</span>
                    : <small>{entry.status === "done" ? t("uploadDone") : entry.status === "queued" ? t("uploadQueued") : new Intl.NumberFormat(locale, { style: "percent" }).format(entry.progress ?? 0)}</small>}
                  {entry.status === "uploading" ? <progress max={1} value={entry.progress ?? 0} aria-label={entry.name} /> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="studio-folder-row">
            <span>{t("importFolderPrompt")}</span>
            <button type="button" className="pill studio-secondary" disabled={uploading} onClick={onImportFolder}><Icon name="folder" />{t("importFolder")}</button>
          </div>
        </section>
        <section className="studio-section studio-delete" aria-labelledby={`${fieldId}-danger`}>
          <div className="studio-section__header">
            <h2 id={`${fieldId}-danger`}>{t("dangerZone")}</h2>
            <button ref={deleteButton} type="button" className="pill pill--danger studio-secondary" disabled={closing || uploading} onClick={() => { setConfirmError(""); setConfirm("delete"); }}>
              <Icon name="trash" />{deleteLabel}
            </button>
          </div>
        </section>
      </div>
      {coverOpen ? (
        <AuthoringDialog title={t(cover.own ? "changeCover" : cover.inherited ? "setCustomCover" : "uploadCover")} onClose={() => { if (!coverBusy) setCoverOpen(false); }}>
          <FilePicker
            icon="upload"
            label={t("chooseCover")}
            hint={t("coverHint")}
            busyLabel={t("uploadingCover")}
            busy={coverBusy}
            progress={coverProgress}
            locale={locale}
            accept="image/png,image/jpeg,image/webp"
            error={coverError}
            onFile={(file) => void uploadCover(file)}
          />
          <div className="dialog-actions"><button type="button" className="pill" disabled={coverBusy} onClick={() => setCoverOpen(false)}>{t("cancel")}</button></div>
        </AuthoringDialog>
      ) : null}
      {confirm ? createPortal(
        <dialog ref={confirmDialog} className="delete-dialog" tabIndex={-1} aria-labelledby={`${dialogId}-title`} aria-describedby={`${dialogId}-body`} onCancel={(event) => { event.preventDefault(); if (!confirmBusy) setConfirm(undefined); }} onMouseDown={(event) => closeOnBackdropPress(event, () => { if (!confirmBusy) setConfirm(undefined); })} onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (!first) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
          <h2 id={`${dialogId}-title`}>{confirm === "delete" ? deleteLabel : t("discardChangesTitle")}</h2>
          {confirm === "delete" ? <p className="delete-dialog__entity" dir="auto">{displayTitle}</p> : null}
          <p id={`${dialogId}-body`}>{confirm === "delete" ? t(target.kind === "topic" ? "deleteTopicBody" : "deleteKeyIssueBody") : t("discardChangesBody")}</p>
          {confirmError ? <p className="field-error" role="alert">{confirmError}</p> : null}
          <div className="dialog-actions">
            <button ref={cancelButton} type="button" className="pill" disabled={confirmBusy} onClick={() => setConfirm(undefined)}>{confirm === "delete" ? t("cancel") : t("keepEditing")}</button>
            <button type="button" className="pill pill--danger" aria-busy={confirmBusy} disabled={confirmBusy} onClick={async () => {
              if (confirmBusy) return;
              setConfirmBusy(true);
              setConfirmError("");
              try {
                if (confirm === "delete") await onDelete();
                else await onDiscard();
              } catch (error) {
                setConfirmError(confirm === "delete" ? t("deleteError") : error instanceof Error && error.message ? error.message : t("discardError"));
                setConfirmBusy(false);
              }
            }}>{confirmBusy ? <Spinner /> : <Icon name={confirm === "delete" ? "trash" : "undo"} />}{confirmBusy && confirm === "delete" ? t("deleting") : confirm === "delete" ? deleteLabel : t("discardChanges")}</button>
          </div>
        </dialog>, document.body
      ) : null}
    </div>
  );
}
