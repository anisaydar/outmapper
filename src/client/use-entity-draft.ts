import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";

export type DraftFields = Record<string, string>;

/** What the server stored for a save: the Project revision and the canonical values it kept (after normalization). */
export interface DraftAck<F extends DraftFields> {
  revision: number;
  values: Partial<F>;
}

export interface DraftSnapshot<F extends DraftFields> {
  values: F;
  /** A field differs from the last acknowledged value or a save is in flight. */
  pending: boolean;
  error: boolean;
}

interface DraftOptions<F extends DraftFields> {
  debounceMs?: number;
  /** Fields that cannot be saved yet (for example an empty required title) stay as local drafts. */
  canSave?: (field: keyof F, value: string) => boolean;
}

/**
 * Per-field draft state for one entity. Each field tracks the local draft and the last base acknowledged by the
 * server. Incoming server values only replace fields that are not dirty, only one save is in flight at a time,
 * and text typed while a save is in flight is saved by the next round instead of being lost.
 */
export class DraftController<F extends DraftFields> {
  private draft: F;
  private base: F;
  private known: F;
  private server: { values: F; revision: number };
  private ackedRevision: number;
  private inflight: Partial<F> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private waiters: Array<(saved: boolean) => void> = [];
  private failed = false;
  private listeners = new Set<() => void>();
  private snapshot: DraftSnapshot<F>;
  private readonly debounceMs: number;
  private readonly canSave: (field: keyof F, value: string) => boolean;
  private saver: (patch: Partial<F>) => Promise<DraftAck<F>> = async () => { throw new Error("Draft saver is not ready"); };
  private onExternalChange: (fields: Array<keyof F>) => void = () => undefined;

  constructor(values: F, revision: number, options: DraftOptions<F> = {}) {
    this.draft = { ...values };
    this.base = { ...values };
    this.known = { ...values };
    this.server = { values: { ...values }, revision };
    this.ackedRevision = revision;
    this.debounceMs = options.debounceMs ?? 600;
    this.canSave = options.canSave ?? (() => true);
    this.snapshot = { values: this.draft, pending: false, error: false };
  }

  setSaver(saver: (patch: Partial<F>) => Promise<DraftAck<F>>): void {
    this.saver = saver;
  }

  /** Called just before drafts are replaced by server values, while the DOM still shows the old text. */
  setExternalChangeHandler(handler: (fields: Array<keyof F>) => void): void {
    this.onExternalChange = handler;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = () => this.snapshot;

  get dirty(): boolean {
    return Boolean(this.inflight) || this.unsavedFields().length > 0;
  }

  set(field: keyof F, value: string): void {
    if (this.draft[field] === value) return;
    this.draft = { ...this.draft, [field]: value };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.pump(), this.debounceMs);
    this.emit();
  }

  /** Saves every pending draft now. Resolves true once everything is persisted, false on failure or invalid drafts. */
  flush(): Promise<boolean> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.pump();
    });
  }

  /** New canonical values from the server. Ignored while a save is in flight or while they predate the last ack. */
  receive(values: F, revision: number): void {
    this.server = { values: { ...values }, revision };
    if (this.inflight || revision < this.ackedRevision) return;
    this.reconcile();
  }

  /** Adopts the server values for every field, discarding drafts (after Undo, Redo, or reload). */
  resync(values: F, revision: number): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.server = { values: { ...values }, revision };
    this.ackedRevision = revision;
    const changed = (Object.keys(values) as Array<keyof F>).filter((field) => this.draft[field] !== values[field]);
    this.draft = { ...values };
    this.base = { ...values };
    this.known = { ...values };
    this.failed = false;
    if (changed.length) this.onExternalChange(changed);
    this.emit();
  }

  /** Saves any remaining valid draft without waiting, for example when the editor unmounts. */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.inflight && this.savablePatch()) this.pump();
  }

  private unsavedFields(): Array<keyof F> {
    return (Object.keys(this.draft) as Array<keyof F>).filter((field) => this.draft[field] !== this.base[field]);
  }

  private savablePatch(): Partial<F> | undefined {
    const fields = this.unsavedFields().filter((field) => this.canSave(field, this.draft[field]));
    if (!fields.length) return undefined;
    return Object.fromEntries(fields.map((field) => [field, this.draft[field]])) as Partial<F>;
  }

  private pump(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.inflight) return;
    const patch = this.savablePatch();
    if (!patch) {
      const saved = this.unsavedFields().length === 0;
      if (saved) this.failed = false;
      this.settle(saved);
      this.emit();
      return;
    }
    this.inflight = patch;
    this.emit();
    this.saver(patch).then((ack) => {
      for (const field of Object.keys(patch) as Array<keyof F>) {
        this.base = { ...this.base, [field]: patch[field] };
        this.known = { ...this.known, [field]: ack.values[field] ?? patch[field] };
      }
      this.ackedRevision = Math.max(this.ackedRevision, ack.revision);
      this.inflight = undefined;
      this.failed = false;
      if (this.server.revision >= this.ackedRevision) this.reconcile();
      if (this.unsavedFields().length === 0) this.settle(true);
      else if (this.timer === undefined) this.pump();
      this.emit();
    }, () => {
      this.inflight = undefined;
      this.failed = true;
      this.settle(false);
      this.emit();
    });
  }

  private reconcile(): void {
    const changed: Array<keyof F> = [];
    for (const field of Object.keys(this.server.values) as Array<keyof F>) {
      const value = this.server.values[field];
      if (value === this.known[field]) continue;
      this.known = { ...this.known, [field]: value };
      if (this.draft[field] === this.base[field] && this.draft[field] !== value) {
        this.draft = { ...this.draft, [field]: value };
        changed.push(field);
      }
      this.base = { ...this.base, [field]: value };
    }
    if (changed.length) this.onExternalChange(changed);
    this.emit();
  }

  private settle(saved: boolean): void {
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve(saved);
  }

  private emit(): void {
    const pending = this.dirty;
    if (this.snapshot.values === this.draft && this.snapshot.pending === pending && this.snapshot.error === this.failed) return;
    this.snapshot = { values: this.draft, pending, error: this.failed };
    for (const listener of this.listeners) listener();
  }
}

type DraftElement = HTMLInputElement | HTMLTextAreaElement;

export interface EntityDraft<F extends DraftFields> extends DraftSnapshot<F> {
  set: (field: keyof F, value: string) => void;
  flush: () => Promise<boolean>;
  isDirty: () => boolean;
  field: (name: keyof F) => {
    value: string;
    onChange: (event: ChangeEvent<DraftElement>) => void;
    onBlur: () => void;
    ref: (element: DraftElement | null) => void;
  };
}

/**
 * Binds a DraftController to an editor. `resyncToken` must change after Undo, Redo, or reload so the editor
 * adopts the server values; the caret of a focused field is clamped instead of jumping to the end.
 */
export function useEntityDraft<F extends DraftFields>({
  values,
  revision,
  resyncToken,
  save,
  canSave,
  debounceMs
}: {
  values: F;
  revision: number;
  resyncToken: number;
  save: (patch: Partial<F>) => Promise<DraftAck<F>>;
  canSave?: (field: keyof F, value: string) => boolean;
  debounceMs?: number;
}): EntityDraft<F> {
  const [controller] = useState(() => new DraftController<F>(values, revision, { canSave, debounceMs }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const elements = useRef(new Map<keyof F, DraftElement>());
  const caret = useRef<{ element: DraftElement; start: number; end: number } | undefined>(undefined);
  const resynced = useRef(resyncToken);
  const serverKey = JSON.stringify(values);

  useEffect(() => {
    controller.setSaver(save);
  }, [controller, save]);

  useEffect(() => {
    controller.setExternalChangeHandler((fields) => {
      const active = document.activeElement;
      const element = fields.map((field) => elements.current.get(field)).find((candidate) => candidate === active);
      caret.current = element ? { element, start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 } : undefined;
    });
  }, [controller]);

  useEffect(() => {
    const server = JSON.parse(serverKey) as F;
    if (resynced.current !== resyncToken) {
      resynced.current = resyncToken;
      controller.resync(server, revision);
    } else {
      controller.receive(server, revision);
    }
  }, [controller, resyncToken, revision, serverKey]);

  useLayoutEffect(() => {
    const pending = caret.current;
    if (!pending || document.activeElement !== pending.element) return;
    caret.current = undefined;
    const length = pending.element.value.length;
    pending.element.setSelectionRange(Math.min(pending.start, length), Math.min(pending.end, length));
  }, [snapshot.values]);

  useEffect(() => () => controller.dispose(), [controller]);

  const set = useCallback((field: keyof F, value: string) => controller.set(field, value), [controller]);
  const flush = useCallback(() => controller.flush(), [controller]);
  const isDirty = useCallback(() => controller.dirty, [controller]);
  const field = useCallback((name: keyof F) => ({
    value: snapshot.values[name],
    onChange: (event: ChangeEvent<DraftElement>) => controller.set(name, event.target.value),
    onBlur: () => { void controller.flush(); },
    ref: (element: DraftElement | null) => {
      if (element) elements.current.set(name, element);
      else elements.current.delete(name);
    }
  }), [controller, snapshot.values]);

  return { ...snapshot, set, flush, isDirty, field };
}
