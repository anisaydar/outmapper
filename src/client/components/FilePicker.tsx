import { useId, useRef, useState } from "react";
import { Icon, Spinner } from "./Icon.js";

interface FilePickerProps {
  label: string;
  hint: string;
  busyLabel: string;
  busy: boolean;
  progress?: number;
  locale?: string;
  disabled?: boolean;
  error?: string;
  accept?: string;
  inputLabel?: string;
  icon?: "upload" | "folder" | "package";
  onFile?: (file: File) => void;
  /** With `multiple`, every chosen or dropped file is passed at once. */
  onFiles?: (files: File[]) => void;
  multiple?: boolean;
  onChoose?: () => void;
}

export function FilePicker({ label, hint, busyLabel, busy, progress, locale, disabled = false, error, accept, inputLabel = label, icon = "upload", onFile, onFiles, multiple = false, onChoose }: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const errorId = useId();
  const acceptsFiles = Boolean(onFile || onFiles);
  const showProgress = busy && progress !== undefined;
  const percent = showProgress ? new Intl.NumberFormat(locale, { style: "percent" }).format(Math.min(1, Math.max(0, progress ?? 0))) : "";
  const choose = (list?: FileList | null) => {
    const files = [...(list ?? [])];
    if (input.current) input.current.value = "";
    if (!files.length || busy || disabled) return;
    if (onFiles) onFiles(multiple ? files : files.slice(0, 1));
    else onFile?.(files[0]!);
  };
  return <div className="file-picker">
    <button
      type="button"
      className="asset-dropzone"
      data-dragging={dragging || undefined}
      aria-busy={busy}
      aria-describedby={error ? errorId : undefined}
      disabled={busy || disabled}
      onClick={() => { if (onChoose) onChoose(); else input.current?.click(); }}
      onDragOver={acceptsFiles ? (event) => { event.preventDefault(); setDragging(true); } : undefined}
      onDragLeave={acceptsFiles ? () => setDragging(false) : undefined}
      onDrop={acceptsFiles ? (event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); } : undefined}
    >
      {busy ? <Spinner className="spinner--large" /> : <Icon name={icon} />}
      <strong>{busy ? busyLabel : label}</strong>
      <small>{showProgress ? percent : hint}</small>
    </button>
    {showProgress ? <progress className="picker-progress" max={1} value={progress} aria-label={busyLabel} /> : null}
    {acceptsFiles ? <input ref={input} className="visually-hidden" type="file" tabIndex={-1} accept={accept} multiple={multiple} aria-label={inputLabel} onChange={(event) => choose(event.target.files)} /> : null}
    {error ? <p id={errorId} className="field-error picker-error" role="alert"><Icon name="alert" />{error}</p> : null}
  </div>;
}
