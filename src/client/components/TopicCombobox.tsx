import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon, Spinner, type IconName } from "./Icon.js";

export interface TopicChoice {
  id: string;
  title: string;
}

/**
 * Extra actions listed after "Create and link new Topic…". This is the extension point for later cross-Project
 * linking ("Link another Project…"). Each one renders exactly like the create option: a leading icon and a label.
 */
export interface TopicComboboxAction {
  id: string;
  label: string;
  icon: IconName;
  onActivate: (query: string) => void;
}

type Item =
  | { kind: "topic"; key: string; topic: TopicChoice }
  | { kind: "create"; key: string }
  | { kind: "action"; key: string; action: TopicComboboxAction };

interface TopicComboboxProps {
  label: string;
  placeholder: string;
  createLabel: string;
  createHint: string;
  topics: TopicChoice[];
  locale?: string;
  busy?: boolean;
  disabled?: boolean;
  actions?: TopicComboboxAction[];
  onSelect: (topicId: string) => void | Promise<void>;
  onCreate: (title: string) => void | Promise<void>;
}

function normalize(value: string, locale?: string): string {
  return value.normalize("NFKC").toLocaleLowerCase(locale).trim();
}

/** Space kept between an open listbox and the edge of its scroll area (it also clears the panel's edge fade). */
const LIST_MARGIN = 24;

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** An editable combobox with list autocomplete (WAI-ARIA APG listbox popup pattern). */
export function TopicCombobox({ label, placeholder, createLabel, createHint, topics, locale, busy = false, disabled = false, actions = [], onSelect, onCreate }: TopicComboboxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<"below" | "above">("below");
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const listId = `${id}-listbox`;
  const hintId = `${id}-hint`;
  const items = useMemo<Item[]>(() => {
    const needle = normalize(query, locale);
    const matches = needle ? topics.filter(({ title }) => normalize(title, locale).includes(needle)) : topics;
    return [
      ...matches.map((topic) => ({ kind: "topic" as const, key: topic.id, topic })),
      { kind: "create" as const, key: "create" },
      ...actions.map((action) => ({ kind: "action" as const, key: action.id, action }))
    ];
  }, [actions, locale, query, topics]);
  const activeIndex = open && active < items.length ? active : -1;
  const canCreate = query.trim().length > 0;

  const close = () => {
    setOpen(false);
    setActive(-1);
    setPlacement("below");
  };

  /**
   * When the listbox opens past the bottom of its scroll area, scroll just enough to show it with the input still in
   * view (block: nearest); if the area cannot scroll that far, open the listbox upward instead.
   */
  useLayoutEffect(() => {
    if (!open || !field.current || !list.current) return;
    const scroller = scrollParent(field.current);
    const area = scroller?.getBoundingClientRect();
    // Scroll padding marks space covered by sticky or fixed chrome, such as the Studio bar and the mobile tab bar.
    const padding = scroller ? getComputedStyle(scroller) : undefined;
    const top = Math.max(area?.top ?? 0, 0) + (parseFloat(padding?.scrollPaddingBlockStart ?? "") || 0);
    const bottom = Math.min(area?.bottom ?? window.innerHeight, window.innerHeight) - (parseFloat(padding?.scrollPaddingBlockEnd ?? "") || 0);
    const hidden = list.current.getBoundingClientRect().bottom + LIST_MARGIN - bottom;
    if (hidden <= 0) return;
    const room = scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : 0;
    if (scroller && room >= hidden && field.current.getBoundingClientRect().top - hidden >= top) scroller.scrollTop += hidden;
    else setPlacement("above");
  }, [open]);
  const activate = (item: Item | undefined) => {
    if (!item || busy) return;
    if (item.kind === "create") {
      if (!canCreate) {
        input.current?.focus();
        return;
      }
      void onCreate(query.trim());
    } else if (item.kind === "topic") {
      void onSelect(item.topic.id);
    } else {
      item.action.onActivate(query.trim());
    }
    setQuery("");
    close();
    input.current?.focus();
  };
  const move = (index: number) => {
    setOpen(true);
    setActive((index + items.length) % items.length);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(open ? activeIndex + 1 : 0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(open ? activeIndex - 1 : items.length - 1);
    } else if ((event.key === "Home" || event.key === "End") && open && activeIndex >= 0) {
      event.preventDefault();
      move(event.key === "Home" ? 0 : items.length - 1);
    } else if (event.key === "Enter") {
      if (!open || activeIndex < 0) return;
      event.preventDefault();
      activate(items[activeIndex]);
    } else if (event.key === "Escape") {
      if (!open && !query) return;
      event.preventDefault();
      event.stopPropagation();
      if (open) close();
      else setQuery("");
    } else if (event.key === "Tab") {
      close();
    }
  };

  return (
    <div className="topic-combobox">
      <div ref={field} className="topic-combobox__field">
        <Icon name="search" />
        <input
          ref={input}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          aria-busy={busy}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(0);
          }}
          onClick={() => setOpen(true)}
          onBlur={close}
          onKeyDown={handleKeyDown}
        />
        {busy ? <Spinner /> : null}
      </div>
      <ul ref={list} id={listId} className="topic-combobox__list" role="listbox" aria-label={label} data-placement={placement} hidden={!open}>
        {items.map((item, index) => {
          const create = item.kind === "create";
          return (
            <li
              key={item.key}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              aria-disabled={create && !canCreate ? true : undefined}
              aria-describedby={create && !canCreate ? hintId : undefined}
              data-kind={item.kind}
              className="topic-combobox__option"
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
              onClick={() => activate(item)}
            >
              {item.kind === "topic" ? <span dir="auto">{item.topic.title}</span> : null}
              {create ? <><Icon name="plus" /><span>{createLabel}</span>{canCreate ? <small dir="auto">{query.trim()}</small> : <small id={hintId}>{createHint}</small>}</> : null}
              {item.kind === "action" ? <><Icon name={item.action.icon} /><span>{item.action.label}</span></> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
