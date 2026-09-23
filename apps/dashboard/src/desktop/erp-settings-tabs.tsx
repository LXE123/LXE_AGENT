import { useEffect, useId, useRef, type ReactNode } from "react";
import { useUiText } from "../shared/i18n";
import { ERP_INTEGRATIONS, desktopSettingsSectionIsDirty, type DesktopSettingsFormValue, type ErpIntegrationName } from "./settings-model";

export function ErpSettingsTabs({ active, baseline, children, form, onSelect }: {
  active: ErpIntegrationName;
  baseline: DesktopSettingsFormValue;
  children: ReactNode;
  form: DesktopSettingsFormValue;
  onSelect: (name: ErpIntegrationName) => void;
}) {
  const t = useUiText();
  const id = useId();
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    buttons.current[ERP_INTEGRATIONS.indexOf(active)]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <div className="desktop-erp-settings">
      <div aria-label={t.desktop.sectionTitles.erp} className="workspace-subnav desktop-erp-tabs" role="tablist">
        {ERP_INTEGRATIONS.map((name, index) => (
          <button
            aria-controls={`${id}-panel`}
            aria-selected={active === name}
            className={`workspace-subnav-item${active === name ? " active" : ""}`}
            id={`${id}-${name}`}
            key={name}
            onClick={() => onSelect(name)}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % ERP_INTEGRATIONS.length
                : event.key === "ArrowLeft" ? (index + ERP_INTEGRATIONS.length - 1) % ERP_INTEGRATIONS.length
                : event.key === "Home" ? 0 : event.key === "End" ? ERP_INTEGRATIONS.length - 1 : null;
              if (next === null) return;
              event.preventDefault();
              onSelect(ERP_INTEGRATIONS[next]!);
              buttons.current[next]?.focus();
              buttons.current[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
            ref={(element) => { buttons.current[index] = element; }}
            role="tab"
            tabIndex={active === name ? 0 : -1}
            type="button"
          >
            {t.desktop.integrationNames[name]}
            {desktopSettingsSectionIsDirty(name, form, baseline) ? (
              <i aria-label={t.desktop.unsavedChanges} className="desktop-settings-dirty-dot" title={t.desktop.unsavedChanges} />
            ) : null}
          </button>
        ))}
      </div>
      <div aria-labelledby={`${id}-${active}`} id={`${id}-panel`} role="tabpanel">
        {children}
      </div>
    </div>
  );
}
