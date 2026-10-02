import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { KnowledgeContext } from "../../domain/knowledge-query.js";
import type { Asset } from "../../domain/types.js";
import { Icon, Spinner } from "./Icon.js";

interface KnowledgePanelLabels {
  topic: string;
  keyIssue: string;
  edit: string;
  knowledge: string;
  noDescription: string;
  emptySection: string;
  local: string;
  external: string;
  pinned: string;
  publications: string;
  videos: string;
  data: string;
  notes: string;
  openFile: string;
  open: string;
  openLink: string;
  itemTypes: Record<string, string>;
  pin: string;
  unpin: string;
  fileUnavailable: string;
  readMore: string;
  showLess: string;
  updated: string;
  editKnowledge: string;
  removeKnowledge: string;
}

interface KnowledgePanelProps {
  context: KnowledgeContext | null;
  labels: KnowledgePanelLabels;
  locale: string;
  preview?: boolean;
  assets: Asset[];
  coverImageUrl?: string;
  onEdit: () => void;
  onTogglePin: (associationId: string, pinned: boolean) => Promise<void>;
  onEditKnowledge: (associationId: string) => void;
  onRemoveKnowledge: (associationId: string) => void;
}

export function KnowledgePanel({ context, labels, locale, preview = false, assets, coverImageUrl, onEdit, onTogglePin, onEditKnowledge, onRemoveKnowledge }: KnowledgePanelProps) {
  const [expandedItemIds, setExpandedItemIds] = useState<Set<string>>(() => new Set());
  const [pendingPinIds, setPendingPinIds] = useState<Set<string>>(() => new Set());
  const [descriptionExpanded, setDescriptionExpanded] = useState(false);
  const sectionsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDescriptionExpanded(false);
      setExpandedItemIds(new Set());
    }, 0);
    return () => window.clearTimeout(timer);
  }, [context?.target.id, context?.target.kind]);
  const sectionTitle = (kind: string, title: string) => {
    if (kind === "pinned") return labels.pinned;
    if (kind === "publications") return labels.publications;
    if (kind === "videos") return labels.videos;
    if (kind === "data") return labels.data;
    if (kind === "notes") return labels.notes;
    return title;
  };

  if (!context) {
    return (
      <div className="knowledge-loading" role="status" aria-label={labels.knowledge}>
        <div className="panel-hero panel-hero--loading" />
        <div className="panel-card"><span className="skeleton skeleton--line" /><span className="skeleton skeleton--line skeleton--short" /></div>
        <span className="skeleton skeleton--heading" />
        <span className="skeleton skeleton--card" />
        <span className="skeleton skeleton--card" />
      </div>
    );
  }

  const updatedAt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(context.entity.updatedAt));

  return (
    <>
      <div className={`panel-hero${coverImageUrl ? " panel-hero--cover" : ""}`}>
        {coverImageUrl ? <img className="panel-cover" key={coverImageUrl} src={coverImageUrl} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : null}
        {!preview ? (
          <button className="pill panel-edit" type="button" onClick={onEdit}>
            <Icon name="edit" />{labels.edit}
          </button>
        ) : null}
        <div>
          <h1 dir="auto" tabIndex={-1}>{context.entity.title}</h1>
          <p>{context.target.kind === "keyIssue" ? labels.keyIssue : labels.topic} · {labels.updated} {updatedAt}</p>
        </div>
      </div>
      <section className="panel-card">
        <p className={descriptionExpanded ? "" : "panel-description--clamped"} dir="auto">{context.entity.description ?? labels.noDescription}</p>
        <button className="text-action panel-read-more" type="button" onClick={() => setDescriptionExpanded((expanded) => !expanded)}>
          {descriptionExpanded ? labels.showLess : labels.readMore}
        </button>
      </section>
      <section className="knowledge-sections" aria-label={labels.knowledge} ref={sectionsRef}>
        <h2>{labels.knowledge}</h2>
        {context.sections.map((section) => (
          <section className="knowledge-section" data-section-kind={section.kind} key={section.id}>
            <h3>{section.kind === "pinned" ? <Icon name="pin" /> : null}{sectionTitle(section.kind, section.title)}</h3>
            {section.items.length === 0 ? (
              <div className="knowledge-empty"><span>{labels.emptySection}</span>{!preview ? <button className="text-action" type="button" aria-label={`${labels.edit}: ${sectionTitle(section.kind, section.title)}`} onClick={onEdit}>{labels.edit}</button> : null}</div>
            ) : (
              section.items.map(({ item, association }) => {
                const expanded = expandedItemIds.has(item.id);
                const detailsId = `knowledge-details-${encodeURIComponent(section.id)}-${encodeURIComponent(association.id)}`;
                const type = item.type.toLowerCase();
                const typeLabel = labels.itemTypes[type] ?? item.type;
                const thumbnailHue = Array.from(item.id).reduce((hue, character) => (hue * 31 + character.charCodeAt(0)) % 360, 0);
                const source = item.source || item.authors?.join(locale === "ar" ? "، " : ", ");
                const attachments = (item.attachmentAssetIds ?? []).map((id) => ({
                  id,
                  asset: assets.find((candidate) => candidate.id === id)
                }));
                const firstAvailableAttachment = attachments.find(({ asset }) => asset);
                const openHref = item.externalUrl ?? (firstAvailableAttachment
                  ? `/api/assets/${encodeURIComponent(firstAvailableAttachment.id)}`
                  : undefined);
                return (
                  <article className="knowledge-item" key={`${section.id}:${item.id}`}>
                    <button
                      type="button"
                      className="knowledge-item__summary"
                      aria-expanded={expanded}
                      aria-controls={detailsId}
                      onClick={() => setExpandedItemIds((current) => {
                        const next = new Set(current);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        return next;
                      })}
                    >
                      <span className="knowledge-thumb" title={typeLabel} style={{ "--knowledge-hue": thumbnailHue } as CSSProperties}><span dir="auto">{typeLabel}</span></span>
                      <span className="knowledge-item__copy">
                        <strong dir="auto">{item.title}</strong>
                        <span className="knowledge-item__metadata">
                          {source ? <b dir="auto">{source}</b> : null}
                          {item.publishedAt ? (
                            <time dateTime={item.publishedAt}>{new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }).format(new Date(item.publishedAt))}</time>
                          ) : null}
                          {item.availability === "local" ? <span><span aria-hidden="true">● </span><span>{labels.local}</span></span> : <span className="visually-hidden">{labels.external}</span>}
                        </span>
                      </span>
                      <span className="knowledge-chevron" aria-hidden="true"><Icon name="chevronRight" /></span>
                    </button>
                    <div className="knowledge-item__details" id={detailsId} hidden={!expanded}>
                      <p dir="auto">{item.summary ?? item.body ?? labels.noDescription}</p>
                      {attachments.length ? (
                        <div className="attachment-list">
                          {attachments.map(({ id, asset }) =>
                            asset ? (
                              <a href={`/api/assets/${encodeURIComponent(id)}`} target="_blank" rel="noreferrer" key={id}>
                                <span dir="auto">{asset.originalFilename}</span>
                                <small>{labels.openFile}</small>
                              </a>
                            ) : (
                              <span className="attachment-missing" key={id}>{labels.fileUnavailable}</span>
                            )
                          )}
                        </div>
                      ) : null}
                      <div className="knowledge-item__actions">
                        {openHref ? (
                          <a className="pill" href={openHref} target="_blank" rel="noreferrer"><Icon name="open" className="icon icon--mirror-rtl" /><span>{type === "link" || type === "web-link" ? labels.openLink : labels.open}</span></a>
                        ) : (
                          <button className="pill" type="button" disabled><Icon name="open" className="icon icon--mirror-rtl" /><span>{labels.open}</span></button>
                        )}
                        {!preview ? (
                          <>
                            <button
                              className="pill"
                              type="button"
                              data-pin-association={association.id}
                              aria-pressed={association.pinned === true}
                              disabled={pendingPinIds.has(association.id)}
                              onClick={(event) => {
                                const pinButton = event.currentTarget;
                                const restoreFocus = pinButton === document.activeElement;
                                setPendingPinIds((current) => new Set(current).add(association.id));
                                void onTogglePin(association.id, !association.pinned)
                                  .catch(() => undefined)
                                  .finally(() => {
                                    setPendingPinIds((current) => {
                                      const next = new Set(current);
                                      next.delete(association.id);
                                      return next;
                                    });
                                    if (restoreFocus) window.requestAnimationFrame(() => {
                                      if (document.activeElement !== document.body && document.activeElement !== pinButton) return;
                                      if (pinButton.isConnected) {
                                        pinButton.focus();
                                        return;
                                      }
                                      Array.from(sectionsRef.current?.querySelectorAll<HTMLButtonElement>("[data-pin-association]") ?? [])
                                        .find((button) => button.dataset.pinAssociation === association.id)?.focus();
                                    });
                                  });
                              }}
                            >
                              {pendingPinIds.has(association.id) ? <Spinner /> : <Icon name="pin" />}
                              <span>{association.pinned ? labels.unpin : labels.pin}</span>
                            </button>
                            <span className="knowledge-item__tools">
                              <button className="icon-action" type="button" aria-label={labels.editKnowledge} data-tooltip={labels.editKnowledge} onClick={() => onEditKnowledge(association.id)}><Icon name="edit" /></button>
                              <button className="icon-action icon-action--danger" type="button" aria-label={labels.removeKnowledge} data-tooltip={labels.removeKnowledge} onClick={() => onRemoveKnowledge(association.id)}><Icon name="trash" /></button>
                            </span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </article>
                );
              })
            )}
          </section>
        ))}
      </section>
    </>
  );
}
