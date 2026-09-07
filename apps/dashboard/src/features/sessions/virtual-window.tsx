import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown } from "lucide-react";
import { processId } from "./process";
import type { ConversationRow } from "./presentation";
import { useUiText } from "../../shared/i18n";

export function ConversationWindow({ rows, renderRow, hasOlder, hasNewer, loadOlder, loadNewer, jumpToLatest, onVisibleGroups, pageError, empty, connection = "attached", onFollowingChange, jumpVersion = 0, retryLatest = false }: {
  connection?: "attached" | "detached"; onFollowingChange?: (following: boolean) => void; jumpVersion?: number; retryLatest?: boolean;
  rows: ConversationRow[]; renderRow: (row: ConversationRow) => React.ReactNode;
  hasOlder: boolean; hasNewer: boolean; loadOlder: () => Promise<unknown>; loadNewer: () => Promise<unknown>;
  jumpToLatest: () => void; onVisibleGroups: (groups: string[]) => void; pageError: string; empty?: React.ReactNode;
}) {
  const t = useUiText();
  const root = useRef<HTMLDivElement>(null);
  const initial = useRef(false);
  const feed = useRef<HTMLDivElement>(null);
  const followIntent = useRef(true);
  const alignmentFrame = useRef<number | undefined>(undefined);
  const readingVersion = useRef(0);
  const touchY = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const retryDirection = useRef<"older" | "newer">("older");
  const [following, setFollowing] = useState(true);
  const [loading, setLoading] = useState(false);
  const [hoveredAnswer, setHoveredAnswer] = useState<string>();
  const [focusedAnswer, setFocusedAnswer] = useState<string>();
  const answerAt = (target: EventTarget | null) => target instanceof Element
    ? target.closest<HTMLElement>("[data-answer-id]")?.dataset.answerId : undefined;
  const answerByTurn = new Map<string, string>();
  const answerByGroup = new Map<string, string>();
  for (const row of rows) if (row.kind === "answer_meta") {
    if (row.turnId) answerByTurn.set(row.turnId, row.id);
    answerByGroup.set(row.groupId, row.id);
  }
  const answerId = (row: ConversationRow) => row.presentation === "final" || row.kind === "artifacts" || row.kind === "answer_meta"
    ? answerByTurn.get(row.turnId) ?? answerByGroup.get(row.groupId) : undefined;
  const getItemKey = useCallback((index: number) => rows[index]!.id, [rows]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => root.current,
    getItemKey, estimateSize: () => 100, overscan: 5, anchorTo: "end", followOnAppend: false,
    // Keep prepend anchoring, but don't let proximity resume following on resize.
    scrollEndThreshold: following ? 80 : -1, useAnimationFrameWithResizeObserver: true,
    // Include edge spacing in virtual measurements and scroll-to-end targets.
    // The bottom fade covers 26px; keep the last row above it.
    paddingStart: 24, paddingEnd: 40,
  });
  const cancelAlignment = useCallback(() => {
    if (alignmentFrame.current !== undefined) cancelAnimationFrame(alignmentFrame.current);
    alignmentFrame.current = undefined;
  }, []);
  const updateFollowing = useCallback((value: boolean) => {
    followIntent.current = value;
    setFollowing(value);
    // Intent must reach the controller before an in-flight history request resolves.
    onFollowingChange?.(value);
  }, [onFollowingChange]);
  const stopFollowing = () => {
    readingVersion.current++;
    cancelAlignment();
    if (!followIntent.current) return;
    updateFollowing(false);
    // Replace the virtualizer's pending end-index reconciliation with a fixed
    // offset. Subsequent measurements must not keep chasing the old end index.
    virtual.setOptions({ ...virtual.options, scrollEndThreshold: -1 });
    if (root.current) virtual.scrollToOffset(root.current.scrollTop);
  };
  const scheduleAlignment = useCallback(() => {
    if (!followIntent.current || connection !== "attached" || alignmentFrame.current !== undefined) return;
    alignmentFrame.current = requestAnimationFrame(() => {
      alignmentFrame.current = undefined;
      if (followIntent.current && virtual.options.count) virtual.scrollToEnd();
    });
  }, [connection, virtual]);
  useLayoutEffect(() => {
    if (jumpVersion) updateFollowing(true);
  }, [jumpVersion, updateFollowing]);
  const totalSize = virtual.getTotalSize();
  useLayoutEffect(() => {
    if (rows.length) initial.current = true;
    scheduleAlignment();
  }, [rows, totalSize, following, jumpVersion, scheduleAlignment]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(scheduleAlignment);
    if (root.current) observer.observe(root.current);
    if (feed.current) observer.observe(feed.current);
    return () => { observer.disconnect(); cancelAlignment(); };
  }, [scheduleAlignment, cancelAlignment]);
  useEffect(() => {
    const ids = new Set(rows.map((row) => row.id));
    for (const key of virtual.itemSizeCache.keys()) if (!ids.has(String(key))) virtual.itemSizeCache.delete(key);
  }, [rows, virtual]);
  const manualAnchor = useRef<{id: string; offset: number; bottom: boolean} | undefined>(undefined);
  const previousRows = useRef(rows);
  const previousIds = new Set(previousRows.current.map(row => row.id));
  const currentIds = new Set(rows.map(row => row.id));
  const folding = previousRows.current.some(row => row.presentation === "process" && !currentIds.has(row.id) && currentIds.has(processId(row)));
  const unfolding = rows.some(row => row.presentation === "process" && !previousIds.has(row.id) && previousIds.has(processId(row)));
  const structureChanged = rows.length !== previousRows.current.length || rows.some((row, index) => row.id !== previousRows.current[index]?.id);
  let anchor: {id: string; offset: number; bottom: boolean} | undefined;
  if ((folding || unfolding || structureChanged && !following) && root.current) {
    const el = root.current;
    const top = el.getBoundingClientRect().top;
    const elements = [...el.querySelectorAll<HTMLElement>("[data-conversation-row]")];
    const first = elements.find(item => item.getBoundingClientRect().bottom > top);
    if (first) {
      let id = first.dataset.conversationRow!;
      let offset = first.getBoundingClientRect().top - top;
      if (!currentIds.has(id)) {
        const old = previousRows.current.find(row => row.id === id);
        if (old) {
          id = processId(old);
          const header = elements.find(item => item.dataset.conversationRow === id);
          offset = header ? Math.max(0, header.getBoundingClientRect().top - top) : 0;
        }
      }
      anchor = {id, offset, bottom: followIntent.current && connection === "attached"};
    }
  }
  if (manualAnchor.current && (folding || unfolding)) anchor = manualAnchor.current;
  const structureKey = JSON.stringify(rows.map(row => row.id));
  useLayoutEffect(() => { previousRows.current = rows; }, [rows]);
  useLayoutEffect(() => {
    manualAnchor.current = undefined;
    if (!anchor) return;
    const saved = anchor;
    const version = readingVersion.current;
    let frame = 0;
    let passes = 0;
    const restore = () => {
      if (readingVersion.current !== version) return;
      if (saved.bottom) scheduleAlignment();
      else {
        const index = rows.findIndex(row => row.id === saved.id);
        const item = root.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
        if (item && root.current) virtual.scrollBy(item.getBoundingClientRect().top - root.current.getBoundingClientRect().top - saved.offset);
        else if (index >= 0) virtual.scrollToIndex(index, {align: "start"});
      }
      if (++passes < 3) frame = requestAnimationFrame(restore);
    };
    restore();
    return () => cancelAnimationFrame(frame);
    // Content-only renders must not cancel restoration between measurement frames.
  }, [structureKey, virtual]);
  const items = virtual.getVirtualItems();
  const visibleIds = items.filter((item) => item.end >= (virtual.scrollOffset ?? 0)
    && item.start <= (virtual.scrollOffset ?? 0) + (root.current?.clientHeight ?? 0)).map((item) => rows[item.index]!.groupId);
  const visibleKey = JSON.stringify([...new Set(visibleIds)]);
  useLayoutEffect(() => { onVisibleGroups(JSON.parse(visibleKey)); }, [visibleKey, onVisibleGroups]);
  const load = useCallback(async (direction: "older" | "newer") => {
    if (busy.current) return;
    busy.current = true; retryDirection.current = direction; setLoading(true);
    try { await (direction === "older" ? loadOlder() : loadNewer()); }
    catch { /* The query owns the actual error, displayed below. */ }
    finally { busy.current = false; setLoading(false); }
  }, [loadOlder, loadNewer]);
  useEffect(() => {
    const el = root.current;
    if (!el || loading || pageError) return;
    if (!rows.length) { if (hasOlder) void load("older"); return; }
    if (!initial.current) return;
    if (el.scrollTop <= 120 && hasOlder && !following) void load("older");
    else if (el.scrollHeight - el.scrollTop - el.clientHeight <= 120 && hasNewer) void load("newer");
  }, [items[0]?.index, items.at(-1)?.index, following, hasOlder, hasNewer, loading, load, pageError, rows.length]);
  return <div className="conversation-scroll-area">
    <div className="conversation-transcript" ref={root} style={{ overflowAnchor: "none" }} tabIndex={0}
      onWheelCapture={(event) => { if (event.deltaY < 0) stopFollowing(); }}
      onTouchStartCapture={(event) => { touchY.current = event.touches[0]?.clientY; }}
      onTouchMoveCapture={(event) => {
        const y = event.touches[0]?.clientY;
        if (y !== undefined && touchY.current !== undefined && y > touchY.current) stopFollowing();
        touchY.current = y;
      }}
      onTouchEndCapture={() => { touchY.current = undefined; }}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, select, [contenteditable=true]")) return;
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stopFollowing();
      }}
      onPointerDownCapture={(event) => {
        const el = root.current;
        // Native scrollbar events target the scroller, including overlay scrollbars.
        if (el && event.target === el && el.scrollHeight > el.clientHeight) stopFollowing();
      }}
      onMouseOver={(event) => setHoveredAnswer(answerAt(event.target))}
      onMouseLeave={() => setHoveredAnswer(undefined)}
      onFocusCapture={(event) => setFocusedAnswer(answerAt(event.target))}
      onBlurCapture={(event) => setFocusedAnswer(answerAt(event.relatedTarget))}
      onClickCapture={(event) => {
      const target = event.target as HTMLElement;
      const button = target.closest(".conversation-process-toggle");
      const row = button?.closest<HTMLElement>("[data-conversation-row]");
      if (row && root.current) {
        stopFollowing();
        manualAnchor.current = {id: row.dataset.conversationRow!, offset: row.getBoundingClientRect().top - root.current.getBoundingClientRect().top, bottom: false};
      }
    }} onScroll={scheduleAlignment}>
      <div className="conversation-feed" ref={feed} style={{ position: "relative", paddingBlock: rows.length ? 0 : undefined, height: rows.length ? totalSize : undefined, minHeight: rows.length ? undefined : "100%" }}>
        {!rows.length ? empty : items.map((item) => <div key={item.key} ref={virtual.measureElement} data-index={item.index}
          data-conversation-row={rows[item.index]!.id} data-display-group={rows[item.index]!.groupId}
          data-answer-id={answerId(rows[item.index]!)}
          data-answer-active={Boolean(answerId(rows[item.index]!) && (answerId(rows[item.index]!) === hoveredAnswer || answerId(rows[item.index]!) === focusedAnswer)) || undefined}
          style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)`, paddingBottom: rows[item.index]!.kind === "process" || rows[item.index]!.presentation === "final" ? 8 : rows[item.index]!.presentation === "process" ? 6 : 12 }}>
          {renderRow(rows[item.index]!)}
        </div>)}
      </div>
    </div>
    {loading ? <span className="conversation-window-loading" aria-live="polite">{t.sessionDetail.loading}</span> : null}
    {pageError ? <div className="message-page-error" role="alert">{pageError}<button onClick={() => retryLatest ? jumpToLatest() : void load(retryDirection.current)}>{t.sessionDetail.retryEarlier}</button></div> : null}
    {!following || connection === "detached" ? <button className="conversation-jump-latest" type="button" onClick={() => {
      updateFollowing(true); jumpToLatest(); scheduleAlignment();
    }}><ChevronDown size={14} />{t.conversation.jumpToLatest}</button> : null}
  </div>;
}
