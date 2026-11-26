/** Preserve actual browser failures while redacting inputs and marking truncation. */
export function browserDiagnostic(error: unknown, secrets: Iterable<string> = []): { exception_type: string; message: string } {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    for (const encoded of [secret, encodeURIComponent(secret)]) {
      message = message.replaceAll(encoded, "[REDACTED]");
    }
  }
  if (message.length > 4000) {
    message = `${message.slice(0, 3800)}... [truncated ${message.length - 3800} chars]`;
  }
  return { exception_type: error instanceof Error ? error.name : "Error", message };
}
