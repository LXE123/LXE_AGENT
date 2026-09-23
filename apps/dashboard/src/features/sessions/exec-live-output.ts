import type { BackgroundTaskChangedPayload } from "@lxe/desktop-protocol";
import type { ConversationDisplayController } from "./display-controller";

/** Subscribe before reading; revisions merge events arriving during recovery. */
export function connectExecLiveOutput(
  controller: ConversationDisplayController,
  subscribe: (receive: (update: BackgroundTaskChangedPayload) => void) => () => void,
  read: () => Promise<{ items: BackgroundTaskChangedPayload[] }>,
  onError: (error: unknown) => void,
) {
  let disposed = false;
  let pending: Promise<void> | undefined;
  let refreshAgain = false;
  const unsubscribe = subscribe(update => { if (!disposed) controller.receiveExecUpdate(update); });
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) { refreshAgain = true; return pending; }
    const revision = controller.getRevision();
    pending = (async () => {
      // Defer one microtask so synchronous read failures also clear the assigned promise.
      await Promise.resolve();
      try {
        const { items } = await read();
        if (!disposed) controller.receiveExecSnapshot(items, revision);
      } catch (error) {
        if (!disposed) onError(error);
      } finally {
        pending = undefined;
        if (refreshAgain && !disposed) { refreshAgain = false; void refresh(); }
      }
    })();
    return pending;
  };
  return { refresh, dispose: () => { disposed = true; unsubscribe(); } };
}
