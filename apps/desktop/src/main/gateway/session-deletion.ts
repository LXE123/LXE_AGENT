export interface SessionDeletionSteps<T> {
  /** Reversible Gateway-side steps. Register each undo as soon as its step is done. */
  detach(onUndo: (undo: () => void) => void): Promise<void>;
  /** The commit point: agentcli removes the Agent session. It cannot be undone. */
  deleteAgentSession(): Promise<T>;
  /** Gateway-side cleanup after the commit, as `[log event, step]`. Each step runs even if an earlier one failed. */
  cleanup: ReadonlyArray<readonly [string, () => void]>;
  /** Final asynchronous cleanup after the commit; it handles its own failures. */
  afterCommit?(): Promise<void>;
  logFailure(event: string, error: unknown): void;
}

/**
 * Deletes a session in the order its owners allow. Before agentcli removes the Agent session,
 * any failure undoes the Gateway steps already done, newest first. After that the deletion has
 * happened, so a cleanup failure is logged and never restores Gateway state onto a missing session.
 */
export async function runSessionDeletion<T>(steps: SessionDeletionSteps<T>): Promise<T> {
  const undos: Array<() => void> = [];
  let result: T;
  try {
    await steps.detach(undo => undos.push(undo));
    result = await steps.deleteAgentSession();
  } catch (error) {
    for (const undo of undos.reverse()) undo();
    throw error;
  }
  for (const [event, step] of steps.cleanup) {
    try {
      step();
    } catch (error) {
      steps.logFailure(event, error);
    }
  }
  await steps.afterCommit?.();
  return result;
}
