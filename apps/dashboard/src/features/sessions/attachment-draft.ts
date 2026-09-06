import type { DesktopDraftAttachmentPayload, DesktopInputAttachmentPayload } from "@lxe/desktop-protocol";

/** Own asynchronous intake order and discard results that outlive their conversation. */
export class ConversationAttachmentDraft {
  items: DesktopDraftAttachmentPayload[] = [];
  pending = 0;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly callbacks: {
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

  stage(load: () => Promise<DesktopDraftAttachmentPayload[]>): Promise<void> {
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
        if (this.items.length + additions.length > 5) {
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
