import { Brain } from "lucide-react";

export type ProviderBrandKind = "kimi" | "deepseek" | "generic";

export function providerBrandKind(provider: string | null | undefined): ProviderBrandKind {
  const normalized = String(provider || "").trim().toLowerCase().replaceAll("-", "_");
  if (["kimi", "kimi_coding", "kimi_code"].includes(normalized)) return "kimi";
  if (["deepseek", "deep_seek"].includes(normalized)) return "deepseek";
  return "generic";
}

export function ProviderBrandMark({
  className = "",
  provider,
  size = 20,
}: {
  className?: string;
  provider: string | null | undefined;
  size?: number;
}) {
  const kind = providerBrandKind(provider);
  const classes = className ? `provider-brand-mark ${className}` : "provider-brand-mark";

  return (
    <span
      aria-hidden="true"
      className={classes}
      data-provider-mark={kind}
      style={{ width: size, height: size }}
    >
      {kind === "kimi" ? (
        <svg fill="none" focusable="false" viewBox="0 0 24 24">
          <circle className="provider-brand-orbit" cx="11.5" cy="12" r="8" />
          <path className="provider-brand-scan" d="M7 8h3.2m3.5 0H16" />
          <path className="provider-brand-scan" d="M4.8 12h4.6l2.3-2.2M9.4 12l2.3 2.2m2-2.2h4.5" />
          <path className="provider-brand-scan" d="M7 16h3.2m3.5 0H16" />
          <circle className="provider-brand-pulse" cx="20.2" cy="6.2" r="1.05" />
        </svg>
      ) : kind === "deepseek" ? (
        <svg fill="none" focusable="false" viewBox="0 0 24 24">
          <path d="M3.2 13.2c2.6-4.1 8.8-5.2 13-2.3 1.4 1 2.2 2.4 2.2 3.8-1.9 3-5.7 4.4-9.2 3.3-2.3-.7-3.8-2.4-4-4.5" />
          <path d="M16.2 10.9c1.3-2.1 3-2.9 4.7-2.4-.2 1.6-1.1 2.8-2.5 3.5 1.5.4 2.5 1.5 2.7 3-1.7.4-3.3-.1-4.5-1.4" />
          <path d="M7.2 14.4c1.6.6 3.3.6 4.8-.1M10.3 9.3c.1-1.5 1-2.6 2.5-3" />
          <circle cx="7" cy="12.6" r="0.75" />
          <circle cx="14.2" cy="5.1" r="0.85" />
        </svg>
      ) : (
        <Brain focusable="false" size={size} strokeWidth={1.8} />
      )}
    </span>
  );
}
