import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

const storageKey = "drop-it.sidebar-collapsed.v1";

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(storageKey) === "true";
  } catch {
    return false;
  }
}

export function rememberSidebarCollapsed(collapsed: boolean) {
  try {
    // Store only this display preference, never library content.
    localStorage.setItem(storageKey, String(collapsed));
  } catch {
    // The control remains usable when browser storage is unavailable.
  }
}

export function SidebarToggle({ collapsed, onToggle }: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      className="icon-button sidebar-toggle"
      aria-label={label}
      title={label}
      aria-expanded={!collapsed}
      aria-controls="library-sidebar"
      onClick={onToggle}
    >
      <Icon size={18} />
    </button>
  );
}
