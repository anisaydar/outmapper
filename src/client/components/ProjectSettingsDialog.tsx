import { useId, useState } from "react";
import type { CanonicalProject } from "../../domain/types.js";
import type { MessageKey } from "../locales.js";
import { useEntityDraft, type DraftAck } from "../use-entity-draft.js";
import { AuthoringDialog } from "./AuthoringDialog.js";
import { Spinner } from "./Icon.js";

type ProjectText = { title: string; description: string };

export function ProjectSettingsDialog({ project, resyncToken, t, onSave, onSaveCopy, onClose }: {
  project: CanonicalProject;
  resyncToken: number;
  t: (key: MessageKey) => string;
  onSave: (patch: Partial<ProjectText>) => Promise<DraftAck<ProjectText>>;
  onSaveCopy: () => Promise<void>;
  onClose: () => void;
}) {
  const draft = useEntityDraft<ProjectText>({
    values: { title: project.manifest.title, description: project.manifest.description ?? "" },
    revision: project.manifest.revision,
    resyncToken,
    save: onSave,
    canSave: (field, value) => field !== "title" || value.trim().length > 0
  });
  const [closing, setClosing] = useState(false);
  const id = useId();
  const titleMissing = !draft.values.title.trim();
  const close = async () => {
    if (closing) return;
    setClosing(true);
    if (await draft.flush()) onClose();
    else setClosing(false);
  };
  return <AuthoringDialog title={t("projectSettingsTitle")} onClose={() => void close()}>
    <form onSubmit={(event) => { event.preventDefault(); void close(); }}>
      <label className="field"><span>{t("projectTitle")}</span><input autoFocus required {...draft.field("title")} aria-invalid={titleMissing} aria-describedby={titleMissing ? `${id}-error` : undefined} /></label>
      {titleMissing ? <p id={`${id}-error`} className="field-error">{t("titleRequired")}</p> : null}
      <label className="field"><span>{t("projectDescription")}</span><textarea rows={4} {...draft.field("description")} /></label>
      {draft.error ? <p className="field-error" role="alert">{t("saveError")}</p> : null}
      <div className="dialog-actions"><button type="button" className="pill" disabled={closing || titleMissing} onClick={() => void (async () => { if (!await draft.flush()) return; setClosing(true); try { await onSaveCopy(); } finally { setClosing(false); } })()}>{t("saveAsCopy")}</button><button type="submit" className="pill pill--accent" aria-busy={closing} disabled={closing || titleMissing}>{closing ? <Spinner /> : null}{t("done")}</button></div>
    </form>
  </AuthoringDialog>;
}
