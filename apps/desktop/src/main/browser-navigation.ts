/** URL policy shared by the manual browser and embedded team catalog. */
export function browserUrl(raw: string, rendererUrl?: string): string {
  const value = raw.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Browser URLs must use HTTP or HTTPS without embedded credentials");
  }
  if (rendererUrl && url.origin === new URL(rendererUrl).origin) {
    throw new Error("The application renderer cannot be opened in the browser panel");
  }
  return url.href;
}

/** Retain the actual failure while removing login codes and signed URLs. */
export function browserNavigationError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL redacted]");
}
