// Small shared presentational components.
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
