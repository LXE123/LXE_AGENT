import type { DesktopDraftAttachmentPayload, DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";

export type ComposerAttachment = DesktopDraftAttachmentPayload & { pastedText?: { text: string; characters: number } };

/** Own asynchronous intake order and discard results that outlive their conversation. */
export class ConversationAttachmentDraft {
  items: ComposerAttachment[] = [];
  private readonly pendingNames = new Set<string>();
  pending = 0;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(public callbacks: {
    changed(): void;
    error(message: string): void;
    discard(ids: string[]): Promise<void>;
    tooMany(): string;
  }) {}

  private discard(items: readonly DesktopInputAttachmentPayload[]): void {
    if (!items.length) return;
    void this.callbacks.discard(items.map((item) => item.attachment_id)).catch((cause) => {
      this.callbacks.error(cause instanceof Error ? cause.message : String(cause));
    });
  }

  async stageText(text: string, characters: number, filename: (n: number) => string,
    save: (text: string, name: string) => Promise<DesktopDraftAttachmentPayload>): Promise<void> {
    const names = new Set([...this.pendingNames, ...this.items.map(item => item.name)]);
    let ordinal = 1;
    while (names.has(filename(ordinal))) ordinal++;
    const name = filename(ordinal);
    this.pendingNames.add(name);
    try {
      await this.stage(async () => [{ ...await save(text, name), pastedText: { text, characters } }]);
    } finally {
      this.pendingNames.delete(name);
    }
  }

  stage(load: () => Promise<ComposerAttachment[]>): Promise<void> {
    const generation = this.generation;
    this.pending += 1;
    this.callbacks.changed();
    // Capture clipboard contents immediately; apply asynchronous results in gesture order.
    const loaded = load().then((items) => ({ items }), (cause: unknown) => ({ cause }));
    const operation = this.tail.then(async () => {
      try {
        const result = await loaded;
        if ("cause" in result) throw result.cause;
        const selected = result.items;
        if (generation !== this.generation) {
          this.discard(selected);
          return;
        }
        const identity = (item: DesktopDraftAttachmentPayload) => item.reference_key ?? item.attachment_id;
        const known = new Set(this.items.map(identity));
        const additions: DesktopDraftAttachmentPayload[] = [];
        const duplicates: DesktopDraftAttachmentPayload[] = [];
        for (const item of selected) {
          if (known.has(identity(item))) {
            if (!this.items.some((existing) => existing.attachment_id === item.attachment_id)) duplicates.push(item);
          } else { known.add(identity(item)); additions.push(item); }
        }
        this.discard(duplicates);
        // Only pasted screenshots carry previews and become model image inputs.
        const screenshotCount = [...this.items, ...additions].filter((item) => item.preview_data_url).length;
        if (screenshotCount > 5) {
          this.discard(additions);
          throw new Error(this.callbacks.tooMany());
        }
        this.items = [...this.items, ...additions];
      } catch (cause) {
        if (generation === this.generation) this.callbacks.error(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (generation === this.generation) {
          this.pending -= 1;
          this.callbacks.changed();
        }
      }
    });
    this.tail = operation;
    return operation;
  }

  remove(id: string): void {
    this.discard(this.items.filter((item) => item.attachment_id === id));
    this.items = this.items.filter((item) => item.attachment_id !== id);
    this.callbacks.changed();
  }

  sent(ids: readonly string[]): void {
    this.items = this.items.filter((item) => !ids.includes(item.attachment_id));
    this.callbacks.changed();
  }

  reset(): void {
    this.generation += 1;
    this.discard(this.items);
    this.items = [];
    this.pending = 0;
    this.callbacks.changed();
  }
}


const drafts = new Map<string, ConversationAttachmentDraft>();
export function conversationAttachments(key: string, callbacks: ConversationAttachmentDraft["callbacks"]): ConversationAttachmentDraft {
  let draft = drafts.get(key);
  if (!draft) { draft = new ConversationAttachmentDraft(callbacks); drafts.set(key, draft); }
  draft.callbacks = callbacks;
  return draft;
}
export function moveConversationAttachments(from: string, to: string): void {
  if (from === to) return;
  const source = drafts.get(from), target = drafts.get(to);
  if (source?.pending || target?.pending) throw new Error("Wait for attachments to finish loading before switching workspaces.");
  if (!source) return;
  const items = [...target?.items ?? [], ...source.items];
  if (items.filter(item => item.preview_data_url).length > 5) throw new Error(source.callbacks.tooMany());
  if (target) { target.items = items; source.items = []; target.callbacks.changed(); }
  else { drafts.set(to, source); drafts.delete(from); }
  source.callbacks.changed();
}
export function forgetConversationAttachments(key: string): void { drafts.get(key)?.reset(); drafts.delete(key); }
