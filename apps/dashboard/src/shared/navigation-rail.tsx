import { Fragment, type ReactNode } from "react";
import type { DashboardSection } from "./navigation";
import { NavigationIcon } from "./navigation-icons";

export function NavigationRail({ items, activeSection, label, onNavigate, footer }: {
  items: Array<{ id: DashboardSection; label: string }>;
  activeSection: DashboardSection;
  label: string;
  onNavigate: (section: DashboardSection) => void;
  footer: ReactNode;
}) {
  return <div className="app-navigation">
    <nav className="navigation-rail-list" aria-label={label}>
      {items.map(item => <Fragment key={item.id}>
        {item.id === "team-skills" && <hr className="navigation-rail-divider" />}
        <button
          type="button"
          className={`navigation-rail-button tab-${item.id}${activeSection === item.id ? " active" : ""}`}
          aria-label={item.label}
          aria-current={activeSection === item.id ? "page" : undefined}
          onClick={() => onNavigate(item.id)}
        >
          <NavigationIcon section={item.id} />
          <span className="navigation-rail-tooltip" aria-hidden="true">{item.label}</span>
        </button>
      </Fragment>)}
    </nav>
    {footer}
  </div>;
}
