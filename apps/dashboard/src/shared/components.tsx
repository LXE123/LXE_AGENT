// Small shared presentational components.
import type { ReactNode } from "react";
import { Info } from "lucide-react";

import { formatNumber } from "./format";

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="empty-state">
      <Info size={18} />
      <span>{label}</span>
    </div>
  );
}

export function CatalogOverview({
  icon,
  eyebrow,
  title,
  description,
  metrics
}: {
  icon: ReactNode;
  eyebrow: string;
  title: string;
  description: string;
  metrics: Array<{ label: string; value: string }>;
}) {
  return (
    <section className="catalog-overview">
      <div className="catalog-overview-copy">
        <div className="catalog-overview-icon" aria-hidden="true">
          {icon}
        </div>
        <div>
          <span className="catalog-overview-eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
      <dl className="catalog-overview-metrics">
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{metric.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function successRateText(executions: number, failures: number): string {
  if (executions <= 0) {
    return "-";
  }
  const rate = ((executions - failures) / executions) * 100;
  return `${Math.round(Math.max(0, Math.min(100, rate)))}%`;
}

export function SuccessRateCell({ executions, failures }: { executions: number; failures: number }) {
  if (executions <= 0) {
    return <span className="usage-num-zero">-</span>;
  }
  const rate = Math.max(0, Math.min(1, (executions - failures) / executions));
  const tone = rate >= 0.98 ? "good" : rate >= 0.9 ? "warn" : "bad";
  return (
    <span className={`rate-cell tone-${tone}`}>
      <span className="rate-cell-track" aria-hidden="true">
        <span className="rate-cell-fill" style={{ width: `${rate * 100}%` }} />
      </span>
      <span className="rate-cell-text">{successRateText(executions, failures)}</span>
    </span>
  );
}

export function FailureCount({ value }: { value: number }) {
  if (value <= 0) {
    return <span className="usage-num-zero">0</span>;
  }
  return <span className="usage-num-danger">{formatNumber(value)}</span>;
}
