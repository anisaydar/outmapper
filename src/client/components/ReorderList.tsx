import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "./Icon.js";

export interface ReorderItem {
  id: string;
  title: string;
  icon?: "project";
}

interface ReorderListProps {
  items: ReorderItem[];
  labels: { moveEarlier: string; moveLater: string; remove?: string };
  /** May return the save; the new order is shown immediately and rolled back only if that save fails. */
  onReorder: (ids: string[], moved: ReorderItem, position: number) => void | Promise<unknown>;
  onRemove?: (id: string) => void;
}

interface DragState {
  id: string;
  from: number;
  to: number;
  startY: number;
  offsetY: number;
  started: boolean;
  /** Vertical midpoints and edges of every row, measured when the drag began. */
  rows: Array<{ id: string; top: number; bottom: number; middle: number }>;
  /** How far the other rows slide to open a gap for the dragged row: its height plus the list gap. */
  slot: number;
}

const DRAG_THRESHOLD = 4;

function moveId(ids: string[], from: number, to: number): string[] {
  const next = [...ids];
  const [id] = next.splice(from, 1);
  next.splice(to, 0, id!);
  return next;
}

/** Applies an optimistic order while it still describes exactly the same set of items. */
function ordered(items: ReorderItem[], pending: string[] | undefined): ReorderItem[] {
  if (!pending || pending.length !== items.length) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const next = pending.map((id) => byId.get(id));
  return next.every(Boolean) ? next as ReorderItem[] : items;
}

/**
 * An ordered list with ↑/↓ buttons for keyboard and screen-reader users, plus a pointer-driven grip for mouse and
 * touch. While dragging, the other rows slide aside to open the drop slot; on drop the new order is shown at once
 * (before the save returns), so nothing snaps back. A drop reorders once, so it is one Undo step.
 */
export function ReorderList({ items, labels, onReorder, onRemove }: ReorderListProps) {
  const [drag, setDrag] = useState<DragState>();
  const [pending, setPending] = useState<string[]>();
  const [settling, setSettling] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const reorderSerial = useRef(0);
  const shown = ordered(items, pending);
  const ids = shown.map(({ id }) => id);

  // Rows land in their new DOM position with their slide offsets removed in the same frame, so transitions stay off
  // for that frame; otherwise displaced rows would visibly slide a second time.
  useEffect(() => {
    if (!settling) return;
    const frame = window.requestAnimationFrame(() => setSettling(false));
    return () => window.cancelAnimationFrame(frame);
  }, [settling]);

  const commit = (from: number, to: number) => {
    if (from === to) return;
    const next = moveId(ids, from, to);
    const serial = ++reorderSerial.current;
    setPending(next);
    const settle = () => { if (serial === reorderSerial.current) setPending(undefined); };
    void Promise.resolve(onReorder(next, shown[from]!, to)).then(settle, settle);
  };

  const begin = (event: ReactPointerEvent<HTMLSpanElement>, index: number) => {
    if (event.button !== 0 || !list.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const rows = [...list.current.querySelectorAll<HTMLElement>("[data-reorder-id]")].map((row) => {
      const rect = row.getBoundingClientRect();
      return { id: row.dataset.reorderId!, top: rect.top, bottom: rect.bottom, middle: rect.top + rect.height / 2 };
    });
    const gap = rows.length > 1 ? Math.max(0, rows[1]!.top - rows[0]!.bottom) : 0;
    const own = rows[index]!;
    setDrag({ id: shown[index]!.id, from: index, to: index, startY: event.clientY, offsetY: 0, started: false, rows, slot: own.bottom - own.top + gap });
  };

  const move = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!drag) return;
    const offsetY = event.clientY - drag.startY;
    if (!drag.started && Math.abs(offsetY) < DRAG_THRESHOLD) return;
    const to = drag.rows.filter(({ id, middle }) => id !== drag.id && middle < event.clientY).length;
    setDrag({ ...drag, offsetY, to, started: true });
  };

  const end = (event: ReactPointerEvent<HTMLSpanElement>, cancelled: boolean) => {
    if (!drag) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    setDrag(undefined);
    if (!drag.started) return;
    setSettling(true);
    if (!cancelled) commit(drag.from, drag.to);
  };

  /** The slide applied to a row that is not being dragged, opening the slot at the current drop position. */
  const shiftFor = (index: number): number => {
    if (!drag?.started || index === drag.from) return 0;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.slot;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.slot;
    return 0;
  };

  return (
    <div ref={list} className="order-list" data-dragging={drag?.started || undefined} data-settling={settling || undefined}>
      {shown.map((item, index) => {
        const dragging = drag?.started && drag.id === item.id;
        const shift = shiftFor(index);
        const style: CSSProperties | undefined = dragging
          ? { transform: `translateY(${drag.offsetY}px)` }
          : shift ? { transform: `translateY(${shift}px)` } : undefined;
        return (
          <div
            className={`order-row${onRemove ? " order-row--removable" : ""}${dragging ? " is-dragging" : ""}`}
            data-reorder-id={item.id}
            data-shifted={shift ? true : undefined}
            key={item.id}
            style={style}
          >
            <span
              className="order-grip"
              aria-hidden="true"
              onPointerDown={(event) => begin(event, index)}
              onPointerMove={move}
              onPointerUp={(event) => end(event, false)}
              onPointerCancel={(event) => end(event, true)}
            ><Icon name="grip" /></span>
            <span className="order-row__title" dir="auto">{item.icon === "project" ? <Icon name="package" /> : null}{item.title}</span>
            <button
              type="button"
              aria-label={`${labels.moveEarlier}: ${item.title}`}
              data-tooltip={labels.moveEarlier}
              disabled={index === 0}
              onClick={() => commit(index, index - 1)}
            ><Icon name="up" /></button>
            <button
              type="button"
              aria-label={`${labels.moveLater}: ${item.title}`}
              data-tooltip={labels.moveLater}
              disabled={index === shown.length - 1}
              onClick={() => commit(index, index + 1)}
            ><Icon name="down" /></button>
            {onRemove && labels.remove ? (
              <button
                type="button"
                className="order-row__remove"
                aria-label={`${labels.remove}: ${item.title}`}
                data-tooltip={labels.remove}
                onClick={() => onRemove(item.id)}
              ><Icon name="close" /></button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
