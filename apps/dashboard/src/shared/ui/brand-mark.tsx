import { useId } from "react";

export interface BrandMarkProps {
  className?: string;
  title?: string;
  tone?: "brand" | "sidebar" | "monochrome";
}

const TONES = {
  brand: { body: "#b46a4d", detail: "#211d1a" },
  sidebar: { body: "#d9a488", detail: "#faf8f5" },
  monochrome: { body: "currentColor", detail: "currentColor" },
} as const;

/** Compact LXE squirrel mark: a curled tail, pointed ear and geometric acorn. */
export function BrandMark({ className, title, tone = "brand" }: BrandMarkProps) {
  const titleId = useId();
  const colors = TONES[tone];
  return (
    <svg
      aria-hidden={title ? undefined : true}
      aria-labelledby={title ? titleId : undefined}
      className={className}
      role={title ? "img" : undefined}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title id={titleId}>{title}</title> : null}
      <path
        d="M30 4C14 4 4 16 4 32c0 14 9 25 23 29l4-11c-9-2-15-9-15-18 0-9 7-16 16-16 7 0 13 5 15 12l11-4C54 12 43 4 30 4Z"
        fill={colors.body}
      />
      <path
        d="M26 60c0-12 3-21 10-27l-1-11 9 7c7 0 11 4 12 9l6 3-6 4c-1 8-7 13-15 15H26Z"
        fill={colors.body}
      />
      <circle cx="48" cy="35" fill={colors.detail} r="1.8" />
      <path
        d="M45 45c1-3 4-5 8-5s7 2 8 5H45Zm2 2h12c0 5-3 9-6 11-3-2-6-6-6-11Z"
        fill={colors.detail}
      />
      <path
        d="M38 43c3 0 6 2 8 5"
        fill="none"
        stroke={colors.body}
        strokeLinecap="round"
        strokeWidth="3.5"
      />
    </svg>
  );
}
