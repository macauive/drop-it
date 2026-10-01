import { LayoutGrid, LayoutList, List } from "lucide-react";

export const layouts = ["standard", "compact", "icon"] as const;
export type LibraryLayout = (typeof layouts)[number];
const storageKey = "drop-it.library-layout";
export function readLayout(): LibraryLayout {
  try {
    const value = localStorage.getItem(storageKey);
    return layouts.includes(value as LibraryLayout)
      ? (value as LibraryLayout)
      : "standard";
  } catch {
    return "standard";
  }
}
export function rememberLayout(layout: LibraryLayout) {
  try {
    // Only a display preference is stored, never library content or credentials.
    localStorage.setItem(storageKey, layout);
  } catch {
    // Storage may be disabled in embedded or private browsing contexts.
  }
}
const choices = [
  { value: "standard", label: "Standard view", Icon: LayoutList },
  { value: "compact", label: "Compact view", Icon: List },
  { value: "icon", label: "Icon view", Icon: LayoutGrid },
] as const;
export function LayoutSwitcher({
  value,
  onChange,
}: {
  value: LibraryLayout;
  onChange: (value: LibraryLayout) => void;
}) {
  return (
    <div className="layout-switcher" role="group" aria-label="Library layout">
      {choices.map(({ value: choice, label, Icon }) => (
        <button
          key={choice}
          type="button"
          className="icon-button"
          aria-label={label}
          title={label}
          aria-pressed={value === choice}
          onClick={() => onChange(choice)}
        >
          <Icon size={18} />
        </button>
      ))}
    </div>
  );
}
