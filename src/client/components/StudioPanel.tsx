import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { KnowledgeContextTarget } from "../../domain/knowledge-query.js";
import type { CanonicalProject, KnowledgeItem } from "../../domain/types.js";
import type { GraphProjection } from "../../graph/projection.js";
import type { HistoryState } from "../api/project-client.js";
import { FilePicker } from "./FilePicker.js";
import { Icon, Spinner } from "./Icon.js";

interface StudioLabels {
  studio: string;
  autosaved: string;
  saving: string;
  saveError: string;
  title: string;
  description: string;
  titleRequired: string;
  done: string;
  undo: string;
  redo: string;
  relationships: string;
  addRelationship: string;
  removeRelationship: string;
  addKeyIssue: string;
  keyIssues: string;
  addKnowledge: string;
  addNote: string;
  knowledgeTitle: string;
  knowledgeBody: string;
  knowledgeType: string;
  knowledgeTypes: Record<string, string>;
  knowledgeUrl: string;
  knowledgeUrlHint: string;
  knowledgeUrlInvalid: string;
  knowledgeDescription: string;
  knowledgeAdding: string;
  knowledgeAddError: string;
  moveEarlier: string;
  moveLater: string;
  attachFile: string;
  dropFile: string;
  uploading: string;
  closeStudio: string;
  deleteTopic: string;
  deleteKeyIssue: string;
  deleteTopicBody: string;
  deleteKeyIssueBody: string;
  deleteError: string;
  deleting: string;
  cancel: string;
}

interface StudioPanelProps {
  project: CanonicalProject;
  displayTopics?: CanonicalProject["topics"];
  projection: GraphProjection;
  target: KnowledgeContextTarget;
  labels: StudioLabels;
  locale?: string;
  saveState: "saved" | "saving" | "error";
  history: HistoryState;
  onSave: (patch: { title: string; description: string }) => Promise<void>;
  onUndo: () => void;
  onRedo: () => void;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onAddKeyIssue: (title: string) => Promise<void>;
  onReorderKeyIssues: (ids: string[]) => Promise<void>;
  onAddRelationship: (targetTopicId: string) => Promise<void>;
  onRemoveRelationship: (relationshipId: string) => Promise<void>;
  onReorderRelationships: (ids: string[]) => Promise<void>;
  onAddKnowledge: (input: Pick<KnowledgeItem, "title" | "body" | "type" | "availability" | "externalUrl">) => Promise<void>;
  onAttachAsset: (file: File, onProgress: (fraction: number) => void) => Promise<void>;
}

export function StudioPanel({
  project,
  displayTopics = project.topics,
  projection,
  target,
  labels,
  locale,
  saveState,
  history,
  onSave,
  onUndo,
  onRedo,
  onClose,
  onDelete,
  onAddKeyIssue,
  onReorderKeyIssues,
  onAddRelationship,
  onRemoveRelationship,
  onReorderRelationships,
  onAddKnowledge,
  onAttachAsset
}: StudioPanelProps) {
  const entity =
    target.kind === "topic"
      ? project.topics.find(({ id }) => id === target.id)
      : project.keyIssues.find(({ id }) => id === target.id);
  const [title, setTitle] = useState(entity?.title ?? "");
  const [description, setDescription] = useState(entity?.description ?? "");
  const [touched, setTouched] = useState(false);
  const [newIssueTitle, setNewIssueTitle] = useState("");
  const [relationshipTarget, setRelationshipTarget] = useState("");
  const [knowledgeTitle, setKnowledgeTitle] = useState("");
  const [knowledgeBody, setKnowledgeBody] = useState("");
  const [knowledgeType, setKnowledgeType] = useState("note");
  const [knowledgeUrl, setKnowledgeUrl] = useState("");
  const [knowledgeUrlChecked, setKnowledgeUrlChecked] = useState(false);
  const [addingKnowledge, setAddingKnowledge] = useState(false);
  const [knowledgeAddError, setKnowledgeAddError] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number>();
  const [attachError, setAttachError] = useState("");
  const [closing, setClosing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const knowledgeFormId = useId();
  const knowledgeUrlInput = useRef<HTMLInputElement>(null);
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
  const deleteLabel = target.kind === "topic" ? labels.deleteTopic : labels.deleteKeyIssue;

  const addKnowledge = async () => {
    if (!knowledgeTitle.trim() || knowledgeSubmission.current || closing || saveState === "saving") return;
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

  const leaveStudio = async (onExit: () => void) => {
    if (closing || saveState === "saving") return;
    if (!title.trim()) {
      titleInput.current?.focus();
      return;
    }
    window.clearTimeout(autosaveTimer.current);
    setClosing(true);
    try {
      if (touched && (title !== entity?.title || description !== (entity?.description ?? ""))) {
        await onSave({ title, description });
      }
      onExit();
    } catch {
      setClosing(false);
    }
  };

  useEffect(() => {
    if (!deleteOpen) return;
    const dialog = deleteDialog.current;
    const trigger = deleteButton.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    cancelButton.current?.focus();
    return () => {
      if (typeof dialog.close === "function") dialog.close();
      trigger?.focus();
    };
  }, [deleteOpen]);

  const attachAsset = async (file: File) => {
    if (uploading) return;
    setUploading(true);
    setUploadProgress(undefined);
    setAttachError("");
    try {
      await onAttachAsset(file, setUploadProgress);
    } catch (error) {
      setAttachError(error instanceof Error && error.message ? error.message : labels.saveError);
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (!touched || !title.trim() || closing || deleteOpen) return;
    if (title === entity?.title && description === (entity?.description ?? "")) return;
    autosaveTimer.current = window.setTimeout(() => {
      void onSave({ title, description }).then(() => setTouched(false)).catch(() => {});
    }, 450);
    return () => window.clearTimeout(autosaveTimer.current);
  }, [closing, deleteOpen, description, entity?.description, entity?.title, onSave, title, touched]);

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
        if (event.shiftKey) onRedo();
        else onUndo();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [history.canRedo, history.canUndo, onRedo, onUndo]);

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
  const relatedIds = new Set(issueRelationships.map(({ targetTopicId }) => targetTopicId));
  const relationshipCandidates = displayTopics.filter(
    ({ id }) => id !== projection.centralTopic.id && !relatedIds.has(id)
  );
  const displayTitle = target.kind === "topic"
    ? projection.centralTopic.title
    : projection.keyIssues.find(({ id }) => id === target.id)?.title ?? entity?.title;

  return (
    <div className="studio-panel">
      <div className="studio-bar">
        <button type="button" className="tool studio-bar__close" aria-label={labels.closeStudio} disabled={closing || saveState === "saving"} onClick={() => void leaveStudio(onClose)}>
          <Icon name="close" />
        </button>
        <span className={`save-state save-state--${saveState}`} role="status">
          {saveState === "saving" ? <Spinner /> : <Icon name={saveState === "error" ? "alert" : "check"} />}
          <span>{saveState === "saving" ? labels.saving : saveState === "error" ? labels.saveError : labels.autosaved}</span>
        </span>
        <div className="studio-bar__history capsule" role="group">
          <button type="button" className="tool" aria-label={labels.undo} aria-keyshortcuts="Control+Z Meta+Z" disabled={!history.canUndo || closing || saveState === "saving"} onClick={onUndo}><Icon name="undo" /></button>
          <button type="button" className="tool" aria-label={labels.redo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z" disabled={!history.canRedo || closing || saveState === "saving"} onClick={onRedo}><Icon name="redo" /></button>
        </div>
        <div className="studio-bar__actions">
          <button type="button" className="pill pill--accent" disabled={closing || saveState === "saving"} onClick={() => void leaveStudio(onClose)}>
            <Icon name="check" />{labels.done}
          </button>
        </div>
      </div>
      <div className="studio-heading">
        <p className="eyebrow">{labels.studio}</p>
        <h1 dir="auto">{displayTitle}</h1>
      </div>
      <div className="studio-form">
        <label>
          <span>{labels.title}</span>
          <input
            ref={titleInput}
            value={title}
            aria-invalid={!title.trim()}
            onChange={(event) => {
              setTitle(event.target.value);
              setTouched(true);
            }}
          />
          {!title.trim() ? <small className="field-error">{labels.titleRequired}</small> : null}
        </label>
        <label>
          <span>{labels.description}</span>
          <textarea
            rows={5}
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
              setTouched(true);
            }}
          />
        </label>

        {target.kind === "topic" ? (
          <section className="studio-section">
            <h2>{labels.keyIssues}</h2>
            <div className="order-list">
              {projection.keyIssues.map((issue, index, issues) => (
                <div className="order-row" key={issue.id}>
                  <Icon name="grip" />
                  <span dir="auto">{issue.title}</span>
                  <button
                    type="button"
                    aria-label={`${labels.moveEarlier}: ${issue.title}`}
                    disabled={index === 0}
                    onClick={() => {
                      const ids = issues.map(({ id }) => id);
                      [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                      void onReorderKeyIssues(ids);
                    }}
                  ><Icon name="up" /></button>
                  <button
                    type="button"
                    aria-label={`${labels.moveLater}: ${issue.title}`}
                    disabled={index === issues.length - 1}
                    onClick={() => {
                      const ids = issues.map(({ id }) => id);
                      [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                      void onReorderKeyIssues(ids);
                    }}
                  ><Icon name="down" /></button>
                </div>
              ))}
            </div>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newIssueTitle.trim()) return;
                void onAddKeyIssue(newIssueTitle).then(() => setNewIssueTitle(""));
              }}
            >
              <input aria-label={labels.addKeyIssue} dir="auto" value={newIssueTitle} onChange={(event) => setNewIssueTitle(event.target.value)} />
              <button className="pill" type="submit" disabled={!newIssueTitle.trim()}>
                <Icon name="plus" />{labels.addKeyIssue}
              </button>
            </form>
          </section>
        ) : (
          <section className="studio-section">
            <h2>{labels.relationships}</h2>
            <div className="relationship-chips">
              {issueRelationships.map((relationship) => (
                <span className="relationship-chip" key={relationship.id}>
                  {displayTopics.find(({ id }) => id === relationship.targetTopicId)?.title}
                  <button
                    type="button"
                    aria-label={`${labels.moveEarlier}: ${relationship.targetTopicId}`}
                    disabled={issueRelationships[0]?.id === relationship.id}
                    onClick={() => {
                      const ids = issueRelationships.map(({ id }) => id);
                      const index = ids.indexOf(relationship.id);
                      [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
                      void onReorderRelationships(ids);
                    }}
                  ><Icon name="up" /></button>
                  <button
                    type="button"
                    aria-label={`${labels.moveLater}: ${relationship.targetTopicId}`}
                    disabled={issueRelationships.at(-1)?.id === relationship.id}
                    onClick={() => {
                      const ids = issueRelationships.map(({ id }) => id);
                      const index = ids.indexOf(relationship.id);
                      [ids[index], ids[index + 1]] = [ids[index + 1], ids[index]];
                      void onReorderRelationships(ids);
                    }}
                  ><Icon name="down" /></button>
                  <button
                    type="button"
                    aria-label={`${labels.removeRelationship}: ${relationship.targetTopicId}`}
                    onClick={() => void onRemoveRelationship(relationship.id)}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              ))}
            </div>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!relationshipTarget) return;
                void onAddRelationship(relationshipTarget).then(() => setRelationshipTarget(""));
              }}
            >
              <select aria-label={labels.addRelationship} value={relationshipTarget} onChange={(event) => setRelationshipTarget(event.target.value)}>
                <option value="">{labels.addRelationship}</option>
                {relationshipCandidates.map((topic) => (
                  <option value={topic.id} key={topic.id}>
                    {topic.title}
                  </option>
                ))}
              </select>
              <button className="pill" type="submit" disabled={!relationshipTarget}>
                <Icon name="plus" />{labels.addRelationship}
              </button>
            </form>
          </section>
        )}

        <section className="studio-section">
          <h2>{labels.addKnowledge}</h2>
          <form
            className="knowledge-form"
            aria-label={labels.addKnowledge}
            aria-busy={addingKnowledge}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void addKnowledge();
            }}
          >
            <label>
              <span id={`${knowledgeFormId}-type-label`}>{labels.knowledgeType}</span>
              <select aria-labelledby={`${knowledgeFormId}-type-label`} value={knowledgeType} disabled={addingKnowledge} onChange={(event) => {
                setKnowledgeType(event.target.value);
                setKnowledgeUrlChecked(false);
                setKnowledgeAddError(false);
              }}>
                {["note", "article", "research-paper", "video", "dataset", "web-link"].map((type) => (
                  <option key={type} value={type}>{labels.knowledgeTypes[type]}</option>
                ))}
              </select>
            </label>
            <label>
              <span>{labels.knowledgeTitle}</span>
              <input
                name="knowledgeTitle"
                required
                dir="auto"
                disabled={addingKnowledge}
                value={knowledgeTitle}
                onChange={(event) => setKnowledgeTitle(event.target.value)}
              />
            </label>
            {externalKnowledge ? (
              <label>
                <span id={`${knowledgeFormId}-url-label`}>{labels.knowledgeUrl}</span>
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
                  <small id={`${knowledgeFormId}-error`} className="field-error" role="alert">{labels.knowledgeUrlInvalid}</small>
                ) : (
                  <small id={`${knowledgeFormId}-hint`} className="field-hint">{labels.knowledgeUrlHint}</small>
                )}
              </label>
            ) : null}
            <label>
              <span>{externalKnowledge ? labels.knowledgeDescription : labels.knowledgeBody}</span>
              <textarea
                rows={3}
                dir="auto"
                disabled={addingKnowledge}
                value={knowledgeBody}
                onChange={(event) => setKnowledgeBody(event.target.value)}
              />
            </label>
            {knowledgeAddError ? <p className="field-error" role="alert">{labels.knowledgeAddError}</p> : null}
            <button className="pill" type="submit" aria-busy={addingKnowledge} disabled={!knowledgeTitle.trim() || addingKnowledge || closing || saveState === "saving"}>
              {addingKnowledge ? <Spinner /> : <Icon name="plus" />}
              {addingKnowledge ? labels.knowledgeAdding : externalKnowledge ? labels.addKnowledge : labels.addNote}
            </button>
          </form>
        </section>
        <section className="studio-section">
          <h2>{labels.attachFile}</h2>
          <FilePicker
            label={labels.attachFile}
            hint={labels.dropFile}
            busyLabel={labels.uploading}
            busy={uploading}
            progress={uploadProgress}
            locale={locale}
            error={attachError}
            onFile={(file) => void attachAsset(file)}
          />
        </section>
        <section className="studio-section studio-delete">
          <button ref={deleteButton} type="button" className="pill pill--danger" disabled={closing || uploading || saveState === "saving"} onClick={() => { setDeleteError(false); setDeleteOpen(true); }}>
            <Icon name="trash" />{deleteLabel}
          </button>
        </section>
      </div>
      {deleteOpen ? createPortal(
        <dialog ref={deleteDialog} className="delete-dialog" tabIndex={-1} aria-labelledby={`${dialogId}-title`} aria-describedby={`${dialogId}-body`} onCancel={(event) => { event.preventDefault(); if (!deleting) setDeleteOpen(false); }} onKeyDown={(event) => {
          if (event.key !== "Tab") return;
          const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (!first) { event.preventDefault(); event.currentTarget.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }}>
          <h2 id={`${dialogId}-title`}>{deleteLabel}</h2>
          <p className="delete-dialog__entity" dir="auto">{displayTitle}</p>
          <p id={`${dialogId}-body`}>{target.kind === "topic" ? labels.deleteTopicBody : labels.deleteKeyIssueBody}</p>
          {deleteError ? <p className="field-error" role="alert">{labels.deleteError}</p> : null}
          <div className="dialog-actions">
            <button ref={cancelButton} type="button" className="pill" disabled={deleting} onClick={() => setDeleteOpen(false)}>{labels.cancel}</button>
            <button type="button" className="pill pill--danger" aria-busy={deleting} disabled={deleting} onClick={async () => {
              if (deleting) return;
              setDeleting(true);
              setDeleteError(false);
              try { await onDelete(); }
              catch { setDeleteError(true); setDeleting(false); }
            }}>{deleting ? <Spinner /> : <Icon name="trash" />}{deleting ? labels.deleting : deleteLabel}</button>
          </div>
        </dialog>, document.body
      ) : null}
    </div>
  );
}
