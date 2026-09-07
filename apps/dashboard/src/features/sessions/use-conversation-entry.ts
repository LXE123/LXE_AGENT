import { useLayoutEffect, useRef } from "react";
import type { ConversationDisplayController } from "./display-controller";

// Route visibility matters: returning from home can keep the same selected ID.
export function useConversationEntry(controller: ConversationDisplayController, sessionId: string, visible: boolean) {
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const entered = visible && sessionId ? sessionId : null;
    if (entered !== null && entered !== previous.current) {
      controller.select(entered);
      controller.jumpToLatest();
    }
    previous.current = entered;
  }, [controller, sessionId, visible]);
}
