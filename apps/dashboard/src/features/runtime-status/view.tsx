import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DesktopHealth } from "@lxe/desktop-protocol";
import { Activity, Bot, Brain, Radio, Server, X } from "lucide-react";

import { useChannelHealthQuery } from "../../api/queries";
import type { ModelPayload } from "../../api/payloads";
import type { DesktopSettingsSection } from "../../desktop/settings-model";
import { useUiText } from "../../shared/i18n";
import {
  aggregateAgentState,
  aggregateRuntimeTone,
  channelTone,
  componentTone,
  summarizeChannelState,
  type RuntimeTone,
} from "./model";

function RuntimeStatusItem({
  icon,
  label,
  meta,
  tone,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  meta?: string;
  tone: RuntimeTone;
  value: string;
  onClick: () => void;
}) {
  const accessibleLabel = `${label}：${value}${meta ? `，${meta}` : ""}`;
  return (
    <button
      aria-label={accessibleLabel}
      className={`runtime-status-item tone-${tone}`}
      onClick={onClick}
      title={accessibleLabel}
      type="button"
    >
      <span className="runtime-status-icon" aria-hidden="true">{icon}</span>
      <span className="runtime-status-copy">
        <span className="runtime-status-label">{label}</span>
        <span className="runtime-status-value-line">
          <strong>{value}</strong>
          {meta ? <span className="runtime-status-meta">· {meta}</span> : null}
        </span>
      </span>
      <span className="runtime-status-dot" aria-hidden="true" />
    </button>
  );
}

export function RuntimeStatusPopover({
  currentModel,
  desktopHealth,
  navigationKey,
  onOpenModels,
  onOpenSettings,
}: {
  currentModel: ModelPayload | null;
  desktopHealth: DesktopHealth;
  navigationKey: string;
  onOpenModels: () => void;
  onOpenSettings: (section: DesktopSettingsSection) => void;
}) {
  const t = useUiText();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const channelsQuery = useChannelHealthQuery();
  const agentState = aggregateAgentState(desktopHealth);
  const channelUnavailable = channelsQuery.isError && !channelsQuery.data;
  const channelState = summarizeChannelState(channelsQuery.data, channelUnavailable);
  const componentStates = t.home.componentStates;
  const channelStates = t.home.channelStates;
  const runtimeTone = aggregateRuntimeTone([
    currentModel ? "healthy" : "neutral",
    componentTone(desktopHealth.gateway),
    componentTone(agentState),
    channelTone(channelState),
  ]);

  useEffect(() => {
    setOpen(false);
  }, [navigationKey]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const closeAndRun = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="runtime-status-floating" ref={rootRef}>
      {open ? (
        <section
          aria-labelledby="runtime-status-popover-title"
          className="runtime-status-popover"
          id="runtime-status-popover"
          role="dialog"
        >
          <div className="runtime-status-popover-heading">
            <h3 id="runtime-status-popover-title">{t.home.runtimeStatus}</h3>
            <button
              className="home-panel-link"
              onClick={() => closeAndRun(() => onOpenSettings("status"))}
              type="button"
            >
              {t.home.openStatusSettings}
            </button>
          </div>
          <div aria-label={t.home.runtimeStatusAria} className="runtime-status-list" role="group">
            <RuntimeStatusItem
              icon={<Brain size={16} />}
              label={t.home.currentModel}
              meta={currentModel?.model || t.home.channelStates.unavailable}
              onClick={() => closeAndRun(onOpenModels)}
              tone={currentModel ? "healthy" : "neutral"}
              value={currentModel?.label || t.home.channelStates.unavailable}
            />
            <RuntimeStatusItem
              icon={<Server size={16} />}
              label={t.home.gateway}
              onClick={() => closeAndRun(() => onOpenSettings("status"))}
              tone={componentTone(desktopHealth.gateway)}
              value={componentStates[desktopHealth.gateway]}
            />
            <RuntimeStatusItem
              icon={<Bot size={16} />}
              label={t.home.agent}
              onClick={() => closeAndRun(() => onOpenSettings("status"))}
              tone={componentTone(agentState)}
              value={componentStates[agentState]}
            />
            <RuntimeStatusItem
              icon={<Radio size={16} />}
              label={t.home.feishu}
              onClick={() => closeAndRun(() => onOpenSettings("feishu"))}
              tone={channelTone(channelState)}
              value={channelStates[channelState]}
            />
          </div>
        </section>
      ) : null}
      <button
        aria-controls="runtime-status-popover"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={open ? t.home.closeRuntimeStatus : t.home.openRuntimeStatus}
        className={`runtime-status-trigger tone-${runtimeTone}${open ? " is-open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title={open ? t.home.closeRuntimeStatus : t.home.openRuntimeStatus}
        type="button"
      >
        <span className="runtime-status-trigger-icons" aria-hidden="true">
          <Activity className="runtime-status-trigger-activity" size={22} />
          <X className="runtime-status-trigger-close" size={22} />
        </span>
        <span className="runtime-status-trigger-dot" aria-hidden="true" />
      </button>
    </div>
  );
}
