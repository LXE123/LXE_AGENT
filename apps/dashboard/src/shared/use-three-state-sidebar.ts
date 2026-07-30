import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent, KeyboardEvent } from "react";

import { initialSidebarExpanded, storeSidebarExpanded } from "./sidebar-preference";

const PEEK_OPEN_DELAY_MS = 180;
const PEEK_CLOSE_DELAY_MS = 120;

export type SidebarDisplayMode = "collapsed" | "peek" | "expanded";

export function useThreeStateSidebar(storage?: Storage) {
  const [collapsed, setCollapsed] = useState(() => !initialSidebarExpanded(storage));
  const [peekOpen, setPeekOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const openTimerRef = useRef(0);
  const closeTimerRef = useRef(0);
  const controlHoveredRef = useRef(false);
  const panelHoveredRef = useRef(false);
  const controlFocusedRef = useRef(false);
  const panelFocusedRef = useRef(false);
  const transientInteractionRef = useRef(false);
  const peekSuppressedRef = useRef(false);
  const keyboardModeRef = useRef(false);

  const clearOpenTimer = useCallback(() => {
    if (!openTimerRef.current) return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = 0;
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = 0;
  }, []);

  const hasActiveRegion = useCallback(() => (
    controlHoveredRef.current
      || panelHoveredRef.current
      || transientInteractionRef.current
      || (keyboardModeRef.current && (controlFocusedRef.current || panelFocusedRef.current))
  ), []);

  const hidePeek = useCallback(() => {
    if (panelRef.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    keyboardModeRef.current = false;
    setPeekOpen(false);
  }, []);

  const scheduleClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = 0;
      if (!hasActiveRegion()) hidePeek();
    }, PEEK_CLOSE_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer, hasActiveRegion, hidePeek]);

  const scheduleOpen = useCallback(() => {
    clearCloseTimer();
    if (!collapsed || peekOpen || peekSuppressedRef.current) return;
    clearOpenTimer();
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = 0;
      if (collapsed && controlHoveredRef.current && !peekSuppressedRef.current) {
        setPeekOpen(true);
      }
    }, PEEK_OPEN_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer, collapsed, peekOpen]);

  const onTransientInteractionChange = useCallback((active: boolean) => {
    transientInteractionRef.current = active;
    clearCloseTimer();
    if (active) return;
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = 0;
      if (!hasActiveRegion()) hidePeek();
    }, PEEK_CLOSE_DELAY_MS);
  }, [clearCloseTimer, hasActiveRegion, hidePeek]);

  useEffect(() => {
    storeSidebarExpanded(!collapsed, storage);
  }, [collapsed, storage]);

  useEffect(() => () => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearCloseTimer, clearOpenTimer]);

  const toggle = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (collapsed) {
      peekSuppressedRef.current = false;
      keyboardModeRef.current = false;
      setPeekOpen(false);
      setCollapsed(false);
      return;
    }
    peekSuppressedRef.current = true;
    keyboardModeRef.current = false;
    setPeekOpen(false);
    setCollapsed(true);
  }, [clearCloseTimer, clearOpenTimer, collapsed]);

  const openForSearch = useCallback(() => {
    if (collapsed && !peekOpen) setPeekOpen(true);
  }, [collapsed, peekOpen]);

  const onEscape = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !collapsed || !peekOpen || event.key !== "Escape") return;
    event.preventDefault();
    clearOpenTimer();
    clearCloseTimer();
    peekSuppressedRef.current = true;
    keyboardModeRef.current = false;
    setPeekOpen(false);
    toggleRef.current?.focus();
  }, [clearCloseTimer, clearOpenTimer, collapsed, peekOpen]);

  const controlProps = {
    onBlurCapture: (event: FocusEvent<HTMLDivElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      controlFocusedRef.current = false;
      peekSuppressedRef.current = false;
      scheduleClose();
    },
    onFocusCapture: () => {
      controlFocusedRef.current = true;
      clearCloseTimer();
      if (collapsed && !peekSuppressedRef.current) {
        if (!controlHoveredRef.current && !panelHoveredRef.current) keyboardModeRef.current = true;
        setPeekOpen(true);
      }
    },
    onKeyDownCapture: onEscape,
    onPointerEnter: () => {
      controlHoveredRef.current = true;
      keyboardModeRef.current = false;
      scheduleOpen();
    },
    onPointerLeave: () => {
      controlHoveredRef.current = false;
      peekSuppressedRef.current = false;
      scheduleClose();
    },
  };

  const panelProps = {
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget)) return;
      panelFocusedRef.current = false;
      scheduleClose();
    },
    onFocusCapture: () => {
      panelFocusedRef.current = true;
      if (!controlHoveredRef.current && !panelHoveredRef.current) keyboardModeRef.current = true;
      clearCloseTimer();
    },
    onKeyDownCapture: onEscape,
    onPointerEnter: () => {
      panelHoveredRef.current = true;
      keyboardModeRef.current = false;
      clearCloseTimer();
    },
    onPointerLeave: () => {
      panelHoveredRef.current = false;
      scheduleClose();
    },
  };

  const expanded = !collapsed;
  const mode: SidebarDisplayMode = expanded ? "expanded" : peekOpen ? "peek" : "collapsed";
  return {
    collapsed,
    controlProps,
    expanded,
    mode,
    onTransientInteractionChange,
    openForSearch,
    panelProps,
    panelRef,
    peekOpen,
    toggle,
    toggleRef,
    visible: mode !== "collapsed",
  };
}
