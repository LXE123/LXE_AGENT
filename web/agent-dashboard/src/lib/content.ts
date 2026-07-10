export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function displayText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text || "";
}

export function shortText(value: unknown, limit = 2200): string {
  const text = displayText(value);
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit)}\n... [truncated]` : text;
}

export function sanitizeForDisplay(value: unknown, options: { truncateStrings?: boolean } = {}): unknown {
  const truncateStrings = options.truncateStrings ?? true;
  if (typeof value === "string") {
    return truncateStrings && value.length > 600 ? `${value.slice(0, 600)}... [${value.length} chars]` : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForDisplay(item, options));
  }
  if (!isRecord(value)) {
    return value;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if ((key === "data" || key === "base64") && typeof item === "string" && item.length > 120) {
      cleaned[key] = `[omitted ${item.length} chars]`;
    } else {
      cleaned[key] = sanitizeForDisplay(item, options);
    }
  }
  return cleaned;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "true");
  textArea.style.position = "fixed";
  textArea.style.left = "-9999px";
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(textArea);
  }
}
