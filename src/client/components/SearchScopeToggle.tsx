export type SearchScope = "project" | "workspace";

export function SearchScopeToggle({ value, label, projectLabel, workspaceLabel, onChange }: {
  value: SearchScope;
  label: string;
  projectLabel: string;
  workspaceLabel: string;
  onChange: (scope: SearchScope) => void;
}) {
  return <div className="segmented search-scope" role="group" aria-label={label}>
    <button type="button" aria-pressed={value === "project"} onClick={() => onChange("project")}>{projectLabel}</button>
    <button type="button" aria-pressed={value === "workspace"} onClick={() => onChange("workspace")}>{workspaceLabel}</button>
  </div>;
}
