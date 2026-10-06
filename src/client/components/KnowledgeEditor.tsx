import { useState } from "react";
import type { CanonicalProject } from "../../domain/types.js";
import type { MessageKey } from "../locales.js";
import { AuthoringDialog } from "./AuthoringDialog.js";

export function KnowledgeEditor({ project, associationId, removing, t, onClose, onSave, onRemove }: { project: CanonicalProject; associationId: string; removing: boolean; t: (key: MessageKey) => string; onClose: () => void; onSave: (input: { title: string; body?: string; summary?: string; externalUrl?: string; scope: "context" | "all" }) => Promise<void>; onRemove: (scope: "context" | "all") => Promise<void> }) {
  const association = project.associations.find(({ id }) => id === associationId)!;
  const item = project.knowledgeItems.find(({ id }) => id === association.knowledgeItemId)!;
  const shared = project.associations.filter(({ knowledgeItemId }) => knowledgeItemId === item.id).length > 1;
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body ?? "");
  const [summary, setSummary] = useState(item.summary ?? "");
  const [url, setUrl] = useState(item.externalUrl ?? "");
  const [scope, setScope] = useState<"context" | "all">("context");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy) return;
    if (!removing && item.availability === "external") {
      try { const value = new URL(url); if (!/^https?:\/\//iu.test(url) || !["https:", "http:"].includes(value.protocol)) throw new Error(); }
      catch { setError(t("knowledgeUrlInvalid")); return; }
    }
    setBusy(true); setError("");
    try {
      if (removing) await onRemove(scope);
      else await onSave({ title, body, ...(item.summary !== undefined ? { summary } : {}), ...(item.availability === "external" ? { externalUrl: url } : {}), scope });
      onClose();
    } catch (error) { setError(error instanceof Error ? error.message : t("saveError")); }
    finally { setBusy(false); }
  };
  return <AuthoringDialog title={t(removing ? "removeKnowledge" : "editKnowledge")} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {removing ? <><p dir="auto"><strong>{item.title}</strong></p><p>{t("removeKnowledgeBody")}</p></> : <>
        <label className="field"><span>{t("knowledgeTitle")}</span><input autoFocus required value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} /></label>
        <label className="field"><span>{t("knowledgeBody")}</span><textarea rows={6} value={body} disabled={busy} onChange={(event) => setBody(event.target.value)} /></label>
        {item.summary !== undefined ? <label className="field"><span>{t("knowledgeDescription")}</span><textarea rows={3} value={summary} disabled={busy} onChange={(event) => setSummary(event.target.value)} /></label> : null}
        {item.availability === "external" ? <label className="field"><span>{t("knowledgeUrl")}</span><input type="url" required dir="ltr" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} /></label> : null}
      </>}
      {shared ? <><p>{t("sharedKnowledge")}</p><label className="field"><span>{t("knowledgeScope")}</span><select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as "context" | "all")}><option value="context">{t("thisContext")}</option><option value="all">{t(removing ? "removeEverywhere" : "allContexts")}</option></select></label></> : null}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
      <div className="dialog-actions"><button type="button" autoFocus={removing} className="pill" disabled={busy} onClick={onClose}>{t("cancel")}</button><button type="submit" className={`pill ${removing ? "pill--danger" : "pill--accent"}`} disabled={busy || !removing && !title.trim()}>{busy ? t("saving") : t(removing ? "removeKnowledge" : "save")}</button></div>
    </form>
  </AuthoringDialog>;
}
