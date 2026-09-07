import type { DesktopConversationActivityPayload, DesktopConversationSendPayload, DesktopConversationTurnPayload, DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";
import type { SessionDetailPayload, SessionMessage } from "../../api/payloads";
import { acknowledgeConversationSend, conversationRows, type ConversationRow, type PendingMessage } from "./presentation";
import { appendConversationWindow, boundConversationWindow, CONVERSATION_BYTE_BUDGET, CONVERSATION_GROUP_BUDGET, mergeLatestConversationWindow, prependConversationWindow } from "./model";
import { isToolTerminal, mergeToolStream } from "./tool-state";

export type WindowConnection = "attached" | "detached";
export interface ConversationDisplaySnapshot {
  sessionId: string;
  viewKey: string;
  detail?: SessionDetailPayload;
  latest?: SessionDetailPayload;
  activity?: DesktopConversationActivityPayload;
  rows: ConversationRow[];
  pending: PendingMessage[];
  connection: WindowConnection;
  following: boolean;
  loadState: "loading" | "ready" | "error";
  error: string;
  jump: number;
}
export interface SendTicket { pendingId: string; sessionId: string; selection: number; message: PendingMessage }
export interface HistoryTicket { sessionId: string; selection: number; window: number; revision: number }
const terminal = (turn: DesktopConversationTurnPayload) => ["completed", "error", "cancelled"].includes(turn.state);
const groups = (page?: SessionDetailPayload) => new Set(page?.messages_page.group_cursors ?? page?.messages.map(message => message.display_group_id) ?? []);
const text = (message: SessionMessage) => Array.isArray(message.content)
  ? message.content.map(block => typeof block === "object" && block ? String("text" in block ? block.text : "thinking" in block ? block.thinking : "") : "").join("")
  : String(message.content ?? "");

/** Selection owns a bounded reading window; pending sends outlive navigation until acknowledged. */
export class ConversationDisplayController {
  private listeners = new Set<() => void>();
  private pending = new Map<string, PendingMessage>();
  private turns = new Map<string, DesktopConversationTurnPayload>();
  // References to terminal rows in the current window, discarded on eviction/selection.
  private toolEvidence = new Map<string, ConversationRow>();
  private visible: string[] = [];
  private selection = 0;
  private revision = 0;
  private historyRevisions = new Map<string, number>();
  private window = 0;
  private touched = new Map<string, number>();
  private state: ConversationDisplaySnapshot = {
    sessionId: "", viewKey: "draft:0", rows: [], pending: [], connection: "attached", following: true,
    loadState: "ready", error: "", jump: 0,
  };
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.state;
  getRevision = () => this.revision;
  beginHistory = (): HistoryTicket => ({ sessionId: this.state.sessionId, selection: this.selection, window: this.window, revision: this.revision });
  isCurrent = (ticket: HistoryTicket): boolean => ticket.sessionId === this.state.sessionId && ticket.selection === this.selection && ticket.window === this.window;
  completeHistory(ticket: HistoryTicket, page: SessionDetailPayload, direction: "latest" | "older" | "newer"): boolean {
    if (!this.isCurrent(ticket)) return false;
    this.receiveHistory(page, direction, ticket.revision); return true;
  }

  select(sessionId: string, newDraft = false): void {
    if (sessionId === this.state.sessionId && !newDraft) return;
    this.selection += 1;
    this.turns.clear(); this.touched.clear(); this.visible = []; this.historyRevisions.clear(); this.toolEvidence.clear();
    this.state = { sessionId, viewKey: sessionId || `draft:${this.selection}`, rows: [], pending: [], connection: "attached",
      following: true, loadState: sessionId ? "loading" : "ready", error: "", jump: 0 };
    this.publish();
  }
  setVisibleGroups = (ids: string[]) => { this.visible = ids; };
  setFollowing = (following: boolean) => {
    if (this.state.following === following) return;
    this.state = { ...this.state, following }; this.notify();
  };
  loading(): void {
    if (this.state.detail || this.state.loadState === "loading") return;
    this.state = { ...this.state, loadState: "loading", error: "" }; this.notify();
  }
  failHistory(error: unknown): void {
    this.state = { ...this.state, loadState: this.state.detail ? "ready" : "error", error: error instanceof Error ? error.message : String(error) };
    this.notify();
  }
  receiveHistory(page: SessionDetailPayload, direction: "latest" | "older" | "newer", requestRevision = this.revision): void {
    if (page.session.session_id !== this.state.sessionId) return;
    // Keep the bounded newest page separately only when reading an older, disconnected window.
    const latest = direction === "latest" ? boundConversationWindow(page) : this.state.latest;
    const previous = this.state.detail;
    if (direction === "latest" && this.state.following && previous?.messages.length && page.messages.length
      && ![...groups(page)].some(id => groups(previous).has(id))) {
      // This replaces the continuous window. Older page reads belong to its predecessor.
      this.window += 1;
    }
    let detail = !previous ? page : direction === "latest"
      ? mergeLatestConversationWindow(previous, page, this.state.following)
      : direction === "older" ? prependConversationWindow(previous, page) : appendConversationWindow(previous, page);
    const tail = latest?.messages_page.newest_cursor;
    let connection: WindowConnection = !tail || groups(detail).has(tail) ? "attached" : "detached";
    const tailMessages = connection === "detached" ? latest?.messages.filter(message => !groups(detail).has(message.display_group_id)) ?? [] : [];
    detail = boundConversationWindow(detail, this.visible, direction === "older" ? "older" : "newer", {
      groups: Math.max(1, CONVERSATION_GROUP_BUDGET - new Set(tailMessages.map(message => message.display_group_id)).size),
      bytes: Math.max(0, CONVERSATION_BYTE_BUDGET - new TextEncoder().encode(JSON.stringify(tailMessages)).byteLength),
    });
    if (tail && !groups(detail).has(tail)) {
      connection = "detached";
      const distinctTail = latest!.messages.filter(message => !groups(detail).has(message.display_group_id));
      detail = boundConversationWindow(detail, this.visible, direction === "older" ? "older" : "newer", {
        groups: Math.max(1, CONVERSATION_GROUP_BUDGET - new Set(distinctTail.map(message => message.display_group_id)).size),
        bytes: Math.max(0, CONVERSATION_BYTE_BUDGET - new TextEncoder().encode(JSON.stringify(distinctTail)).byteLength),
      });
    }
    this.state = { ...this.state, detail, latest, connection, loadState: "ready", error: "" };
    for (const message of page.messages) if (message.turn) {
      const id = message.turn.turn_id;
      this.historyRevisions.set(id, Math.max(this.historyRevisions.get(id) ?? -1, requestRevision));
    }
    this.confirmPending(page.messages);
    for (const message of page.messages) {
      const id = message.turn?.turn_id;
      const turn = id ? this.turns.get(id) : undefined;
      const status = message.turn?.status;
      if (turn && (this.touched.get(id!) ?? 0) <= requestRevision && status && ["completed", "error", "cancelled"].includes(status)) {
        this.turns.set(id!, { ...turn, state: status as DesktopConversationTurnPayload["state"] });
      }
    }
    if (this.state.activity) {
      const activity = this.state.activity;
      const active = activity.active ? this.turns.get(activity.active.turn_id) ?? activity.active : null;
      this.state = { ...this.state, activity: { ...activity, active: active && !terminal(active) ? active : null,
        latest: active && terminal(active) ? active : activity.latest,
        queued: activity.queued.filter(turn => !terminal(this.turns.get(turn.turn_id) ?? turn)) } };
    }
    this.pruneTurns(requestRevision);
    this.publish();
  }
  receiveActivity(activity: DesktopConversationActivityPayload): void {
    if (activity.session_id !== this.state.sessionId) return;
    for (const value of [activity.active, activity.latest, ...activity.queued]) {
      if (!value) continue;
      const previous = this.turns.get(value.turn_id);
      const savedStatus = this.state.detail?.messages.find(message => message.turn?.turn_id === value.turn_id)?.turn?.status;
      // Confirmed payloads may already have been released. A delayed running push
      // must not revive that turn or replace the persisted final text with a draft.
      const incoming = !previous && !terminal(value) && savedStatus && ["completed", "error", "cancelled"].includes(savedStatus)
        ? { ...value, state: savedStatus as DesktopConversationTurnPayload["state"], stream: undefined } : value;
      const state = previous && terminal(previous) && !terminal(incoming) ? previous.state : incoming.state;
      const stream = mergeToolStream(previous?.stream, incoming.stream);
      const turn = previous ? { ...previous, ...incoming, state, ...(stream ? { stream } : {}) } : incoming;
      if (!previous || previous.state !== turn.state || previous.stream !== turn.stream) this.touched.set(turn.turn_id, ++this.revision);
      this.turns.set(turn.turn_id, turn);
    }
    const resolve = (turn: DesktopConversationTurnPayload | null) => turn ? this.turns.get(turn.turn_id)! : null;
    const active = resolve(activity.active);
    const latest = resolve(activity.latest) ?? (active && terminal(active) ? active : null);
    this.state = { ...this.state, activity: { ...activity, active: active && !terminal(active) ? active : null, latest,
      queued: activity.queued.map(turn => resolve(turn)!).filter(turn => !terminal(turn)) } };
    this.pruneTurns(-1);
    this.publish();
  }
  jumpToLatest = (): void => {
    this.visible = [];
    this.window += 1;
    this.state = { ...this.state, detail: this.state.latest, connection: "attached", following: true,
      loadState: this.state.latest || !this.state.sessionId ? "ready" : "loading", error: "", jump: this.state.jump + 1 };
    this.publish();
  };
  beginSend(message: string, attachments: DesktopInputAttachmentPayload[]): SendTicket {
    this.jumpToLatest();
    const pendingId = crypto.randomUUID();
    this.pending.set(pendingId, { pendingId, sessionId: this.state.sessionId, text: message, attachments, createdAt: Date.now(), draftKey: this.state.viewKey });
    this.publish();
    return { pendingId, sessionId: this.state.sessionId, selection: this.selection, message: this.pending.get(pendingId)! };
  }
  acceptSend(ticket: SendTicket, result: DesktopConversationSendPayload): boolean {
    const item = this.pending.get(ticket.pendingId) ?? ticket.message;
    const accepted = { ...item, sessionId: result.session_id, turnId: result.turn_id, messageId: result.message_id };
    this.pending.set(ticket.pendingId, accepted);
    const selected = ticket.selection === this.selection && ticket.sessionId === this.state.sessionId;
    if (selected && !ticket.sessionId) this.state = { ...this.state, sessionId: result.session_id, loadState: "loading" };
    if (result.session_id === this.state.sessionId) {
      const completedInHistory = this.state.detail?.messages.some(message => message.turn?.turn_id === result.turn_id && ["completed", "error", "cancelled"].includes(message.turn.status ?? ""));
      if (!completedInHistory) this.receiveActivity(acknowledgeConversationSend(this.state.activity, result, accepted));
      if (this.state.detail) this.confirmPending(this.state.detail.messages);
    }
    this.publish();
    return selected;
  }
  failSend(ticket: SendTicket, error: unknown): void {
    const item = this.pending.get(ticket.pendingId);
    if (item) this.pending.set(ticket.pendingId, { ...item, error: error instanceof Error ? error.message : String(error) });
    this.publish();
  }
  private confirmPending(messages: SessionMessage[]): void {
    for (const [id, item] of this.pending) {
      if (item.sessionId !== this.state.sessionId) continue;
      const persisted = messages.find(message => message.role === "user" && message.client_message_id === id);
      if (!persisted) continue;
      const attachments = new Set(persisted.attachments?.map(attachment => attachment.attachment_id) ?? []);
      if (item.attachments.every(attachment => attachments.has(attachment.attachment_id))) this.pending.delete(id);
    }
  }
  private pruneTurns(requestRevision: number): void {
    const history = conversationRows(this.state.detail?.messages ?? [], [], []);
    const stored = new Map(history.map(row => [row.id, row]));
    const shownTurns = new Set(history.map(row => row.turnId));
    const current = new Set([this.state.activity?.active?.turn_id, this.state.activity?.latest?.turn_id, ...this.state.activity?.queued.map(turn => turn.turn_id) ?? []]);
    for (const [id, turn] of this.turns) {
      if (!terminal(turn)) continue;
      if (!shownTurns.has(id) && !current.has(id) && ![...this.pending.values()].some(item => item.turnId === id)) {
        this.turns.delete(id); this.touched.delete(id); this.historyRevisions.delete(id); continue;
      }
      if ((this.touched.get(id) ?? 0) > requestRevision) continue;
      const rows = conversationRows([], [turn], []).filter(row => row.kind !== "answer_meta");
      const confirmed = rows.every(row => {
        const saved = stored.get(row.id);
        if (!saved) return false;
        if (row.kind === "status") return saved.status === turn.state;
        if (row.message) return Boolean(saved.message) && text(row.message) === text(saved.message!) && (row.message.attachments ?? []).every(attachment => saved.message?.attachments?.some(value => value.attachment_id === attachment.attachment_id));
        // Tools are only released once history contains their finished execution result.
        const liveStatus = row.liveTool?.status;
        return isToolTerminal(liveStatus) && saved.operation?.result !== undefined
          && saved.operation?.status === liveStatus;
      });
      if (confirmed) { this.turns.delete(id); this.touched.delete(id); this.historyRevisions.delete(id); }
    }
  }
  private publish(): void {
    const pending = [...this.pending.values()].filter(item => item.sessionId === this.state.sessionId && (item.sessionId || item.draftKey === this.state.viewKey));
    const turns = this.state.connection === "attached" ? [...this.turns.values()] : [];
    const changedDuringHistory = new Set([...this.touched].filter(([id, revision]) => revision > (this.historyRevisions.get(id) ?? -1)).map(([id]) => id));
    const rows = conversationRows(this.state.detail?.messages ?? [], turns, this.state.connection === "attached" ? pending : [], changedDuringHistory);
    const evidence = new Map<string, ConversationRow>();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index]!;
      if (row.kind !== "tool") continue;
      const key = JSON.stringify([row.turnId || row.groupId, row.id]);
      const confirmed = this.toolEvidence.get(key);
      const confirmedStatus = confirmed?.operation?.status ?? confirmed?.liveTool?.status;
      // A matching persisted result releases the live details. A call-only or stale
      // history response retains the already observed terminal result.
      const persisted = row.operation?.result !== undefined && row.operation?.status === confirmedStatus;
      if (confirmed && !persisted) rows[index] = { ...row, operation: confirmed.operation, liveTool: confirmed.liveTool };
      const current = rows[index]!;
      if (isToolTerminal(current.operation?.status ?? current.liveTool?.status)) evidence.set(key, current);
    }
    this.toolEvidence = evidence;
    this.state = { ...this.state, pending, rows };
    this.notify();
  }
  private notify(): void { this.listeners.forEach(listener => listener()); }
}

/** Shared by the production send handler and browser fixtures. */
export async function sendConversationMessage(controller: ConversationDisplayController, text: string, attachments: DesktopInputAttachmentPayload[],
  send: (input: { session_id?: string; text: string; client_message_id: string; attachment_ids?: string[] }) => Promise<DesktopConversationSendPayload>) {
  const ticket = controller.beginSend(text, attachments);
  try {
    const result = await send({ ...(ticket.sessionId ? { session_id: ticket.sessionId } : {}), text, client_message_id: ticket.pendingId,
      ...(attachments.length ? { attachment_ids: attachments.map(attachment => attachment.attachment_id) } : {}) });
    return { result, ticket, selected: controller.acceptSend(ticket, result) };
  } catch (error) { controller.failSend(ticket, error); throw error; }
}
